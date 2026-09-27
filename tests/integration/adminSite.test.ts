import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createAdminSite, type AdminSite } from "../../src/server/adminSite.ts";
import { hashLanPassword } from "../../src/server/admin/lanAccess.ts";
import { makeApp, makeConfig } from "./helpers/adminFixture.ts";

/*
 * `npm start` 起的管理后台页面（server/adminSite.ts）：真实 socket，真实监听地址切换。
 * 局域网请求从本机网卡地址发起，模拟另一台机器（离线守卫只允许本机地址）。
 */

const PASSWORD = "fake-lan-password";
const INDEX = "<!doctype html><title>fake admin</title>";

/** 本机一个私网 IPv4 地址；没有时跳过局域网用例（例如只有回环的 CI 容器）。 */
function lanIp(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

let root: string;
let site: AdminSite | undefined;
let port: number;
let nextPort = 25_173;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-site-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), INDEX);
  await writeFile(join(root, "assets", "app.js"), "console.log(1)");
  port = nextPort++;
});

afterEach(async () => {
  await site?.close();
  site = undefined;
  await rm(root, { recursive: true, force: true });
});

function hit(
  host: string,
  path: string,
  opts: { headers?: Record<string, string>; localAddress?: string } = {},
): Promise<{ status: number; body: string; cookie: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path, headers: opts.headers, ...(opts.localAddress !== undefined ? { localAddress: opts.localAddress } : {}) },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, cookie: ([] as string[]).concat(res.headers["set-cookie"] ?? [])[0] }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function start(config = makeConfig()) {
  const fixture = makeApp(config);
  site = createAdminSite({ root, port, gatewayFetch: fixture.app.fetch, log: () => {} });
  return fixture;
}

describe("后台页面", () => {
  it("伺服构建产物与 index.html 回退，/api 交给网关，/v1 与源码路径不提供", async () => {
    // 真实 socket 下 getConnInfo 读得到真实对端，不用测试注入的地址。
    const fixture = makeApp(makeConfig());
    site = createAdminSite({ root, port, gatewayFetch: fixture.app.fetch, log: () => {} });
    await site.sync(false);
    expect(site.host()).toBe("127.0.0.1");

    expect((await hit("127.0.0.1", "/")).body).toBe(INDEX);
    expect((await hit("127.0.0.1", "/assets/app.js")).body).toBe("console.log(1)");
    expect((await hit("127.0.0.1", "/workers")).body).toBe(INDEX);
    expect((await hit("127.0.0.1", "/api/ping")).status).toBe(200);
    // 转发面不在这个端口上：/v1 只会拿到页面，拿不到网关响应。
    const v1 = await hit("127.0.0.1", "/v1/models");
    expect(v1.body).toBe(INDEX);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "//etc/passwd", "/src/admin/main.tsx"]) {
      expect((await hit("127.0.0.1", p)).body, p).not.toContain("zen-gateway\"");
    }
  });

  it("未设口令只监听回环；设口令后改为 0.0.0.0，关掉后退回", async () => {
    start();
    await site!.sync(false);
    expect(site!.host()).toBe("127.0.0.1");
    await site!.sync(true);
    expect(site!.host()).toBe("0.0.0.0");
    await site!.sync(false);
    expect(site!.host()).toBe("127.0.0.1");
  });

  it("没有 dist/admin 时不监听，也不影响网关", async () => {
    await rm(join(root, "index.html"));
    start();
    await site!.sync(true);
    expect(site!.host()).toBeNull();
  });
});

const ip = lanIp();
describe.skipIf(ip === null)("局域网访问（真实对端）", () => {
  async function lanSetup() {
    const config = makeConfig();
    const fixture = start({ ...config, gateway: { ...config.gateway, lanPasswordHash: hashLanPassword(PASSWORD) } });
    await site!.sync(true);
    return fixture;
  }

  it("局域网对端即使写 Host: 127.0.0.1 也冒充不了本机", async () => {
    await lanSetup();
    const spoof = await hit(ip!, "/api/overview", { headers: { host: "127.0.0.1" }, localAddress: ip! });
    expect(spoof.status).toBe(403);
    const status = await hit(ip!, "/api/lan/status", { headers: { host: `${ip}:${port}` }, localAddress: ip! });
    expect(JSON.parse(status.body)).toMatchObject({ local: false, authenticated: false });
  });

  it("局域网对端：未登录 401，登录后 200；本机浏览器不需要登录", async () => {
    await lanSetup();
    const host = `${ip}:${port}`;
    expect((await hit(ip!, "/api/overview", { headers: { host }, localAddress: ip! })).status).toBe(401);
    expect((await hit("127.0.0.1", "/api/overview")).status).toBe(200);

    const login = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const body = JSON.stringify({ password: PASSWORD });
      const req = request(
        { host: ip!, port, path: "/api/lan/login", method: "POST", localAddress: ip!, headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, cookie: String(([] as string[]).concat(res.headers["set-cookie"] ?? [])[0]).split(";")[0]! }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(login.status).toBe(200);
    expect((await hit(ip!, "/api/overview", { headers: { host, cookie: login.cookie }, localAddress: ip! })).status).toBe(200);
  });
});
