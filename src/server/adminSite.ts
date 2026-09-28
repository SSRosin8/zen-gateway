import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { isLoopbackAddress, LAN_PEER } from "./middleware/loopbackOnly.ts";

/**
 * 管理后台的页面服务：伺服构建好的 `dist/admin`，并把 `/api` 与 `/health` 交给网关 app。
 * `npm start` 一条命令同时得到网关与后台，不再需要另开 `npm run dev`。
 *
 * ## 为什么是另一个端口，而不是挂在网关端口上
 *
 * 转发面 `/v1/*` 永远只在回环端口上。局域网访问后台时要监听 0.0.0.0，
 * 放在同一个端口上等于把转发面也开给了局域网。所以后台单独一个端口（ADMIN_PORT），
 * 它只转发 `/api` 与 `/health`，其余路径只从 `dist/admin` 取静态文件。
 *
 * ## 监听地址随局域网口令切换
 *
 * 未设口令只监听 127.0.0.1；设了口令改为 0.0.0.0，关掉口令再退回回环。
 * 请求仍经网关 app 的 `loopbackOnly`：局域网请求要带口令会话（见 `lanAccess.ts`）。
 *
 * ## 局域网身份由真实对端决定，不看 Host
 *
 * 闸门只接受回环 TCP 对端，所以非回环对端转交前把地址换成回环，同时打上 `LAN_PEER` 标记。
 * 闸门见到标记就一律按局域网请求处理：局域网设备自己写 `Host: 127.0.0.1` 也冒充不了本机。
 * 真实对端是回环（本机浏览器）时原样转交。
 */

export type AdminSite = {
  /** 当前监听地址；未监听为 null。 */
  readonly host: () => string | null;
  /** 按是否开启局域网访问切换监听地址；地址不变时什么都不做。 */
  readonly sync: (lanEnabled: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
};

export function createAdminSite(opts: {
  /** `dist/admin` 所在目录。 */
  readonly root: string;
  readonly port: number;
  /** 网关 app 的 fetch：`/api` 与 `/health` 原样交给它。 */
  readonly gatewayFetch: (req: Request, env: unknown) => Response | Promise<Response>;
  readonly log: (message: string) => void;
}): AdminSite {
  const site = new Hono();
  const forward = (c: { req: { raw: Request }; env: unknown }) => opts.gatewayFetch(c.req.raw, peerEnv(c.env));
  site.all("/api/*", forward);
  site.get("/health", forward);
  /*
   * 缓存：升级重启后浏览器必须拿到新的 index.html，否则它引用的是已被新构建删掉的旧资源名。
   * 所以页面（index.html 与页面路由回退）一律 `no-cache`（每次向服务端确认）；
   * `/assets/` 下的文件名带内容哈希，内容变了名字就变，可以长期缓存。
   * 找不到的 `/assets/` 直接 404：回退成 index.html 会让浏览器把 HTML 当脚本执行，页面白屏且不报原因。
   */
  const page = (c: { header: (k: string, v: string) => void }) => c.header("Cache-Control", "no-cache");
  site.use(
    "/assets/*",
    serveStatic({ root: opts.root, onFound: (_p, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }),
  );
  site.get("/assets/*", (c) => c.text("Not Found", 404, { "Cache-Control": "no-store" }));
  // 只伺服构建产物目录；serveStatic 拒绝 `..` 与重复斜杠，页面路由都回到 index.html。
  site.use("/*", serveStatic({ root: opts.root, onFound: (_p, c) => page(c) }));
  site.get("*", serveStatic({ root: opts.root, path: "index.html", onFound: (_p, c) => page(c) }));

  const listener = getRequestListener(site.fetch);
  let server: Server | null = null;
  let current: string | null = null;
  let pending: Promise<void> = Promise.resolve();

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (server === null) return resolve();
      const s = server;
      server = null;
      current = null;
      s.close(() => resolve());
      s.closeAllConnections();
    });

  const listen = (host: string): Promise<void> =>
    new Promise((resolve) => {
      const s = createServer(listener);
      s.once("error", (err: NodeJS.ErrnoException) => {
        // 后台端口被占不影响网关本身：转发照常，只是没有页面。
        opts.log(
          err.code === "EADDRINUSE"
            ? `管理后台端口 ${opts.port} 已被占用(可能是 npm run dev 或另一个实例),后台页面未启动`
            : `管理后台监听失败:${err.message}`,
        );
        resolve();
      });
      s.listen(opts.port, host, () => {
        server = s;
        current = host;
        opts.log(
          host === "0.0.0.0"
            ? `管理后台 → http://127.0.0.1:${opts.port}(已开启局域网访问,需要访问口令)`
            : `管理后台 → http://127.0.0.1:${opts.port}`,
        );
        resolve();
      });
    });

  return {
    host: () => current,
    sync: (lanEnabled) => {
      const want = lanEnabled ? "0.0.0.0" : "127.0.0.1";
      pending = pending.then(async () => {
        if (!existsSync(join(opts.root, "index.html"))) {
          opts.log("没有找到构建好的管理后台(dist/admin),运行 npm run build 后重启");
          return;
        }
        if (current === want) return;
        await stop();
        await listen(want);
      });
      return pending;
    },
    close: () => {
      pending = pending.then(stop);
      return pending;
    },
  };
}

/**
 * 转交给网关 app 前处理对端（见文件头）。`getConnInfo` 从 `env.incoming.socket` 读地址：
 * 非回环对端换成只暴露回环地址的替身并打上 `LAN_PEER`；回环对端原样转交。
 */
function peerEnv(env: unknown): unknown {
  const e = env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  if (e?.incoming === undefined) return { [LAN_PEER]: true };
  if (isLoopbackAddress(e.incoming.socket?.remoteAddress)) return env;
  const socket = { remoteAddress: "127.0.0.1", remoteFamily: "IPv4", remotePort: 0 };
  return { ...e, [LAN_PEER]: true, incoming: Object.assign(Object.create(e.incoming as object), { socket }) };
}
