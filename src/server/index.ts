import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "../store/config.ts";
import { EgressService } from "../core/proxy/egress.ts";
import { ConfigError } from "../store/config.ts";

/**
 * 服务入口。
 *
 * 启动顺序刻意如下:**先加载配置,后监听端口**。
 * 反过来的话,一份坏配置会让服务先占住端口再崩,而 service.mjs 的健康等待
 * 会在超时后报「启动失败」,却不说是配置的问题 —— 用户拿不到可自查的信息。
 */

async function main(): Promise<void> {
  let config;
  let created = false;
  try {
    const loaded = await loadConfig();
    config = loaded.config;
    created = loaded.created;
  } catch (err) {
    if (err instanceof ConfigError) {
      // 配置错误要能自查:报路径与原因,但 ConfigError 已保证不含文件内容。
      console.error(`配置无法加载(${err.kind}):${err.message}`);
      if (err.detail !== undefined) console.error(err.detail);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  /*
   * 出口服务在进程内**唯一**。
   *
   * 转发与探测共用它 —— 见 EgressService.upstreamDeps 的说明:
   * Clash selector 的 `now` 是进程外的全局状态,两套锁会让探测量到的出口
   * 与转发实际用的出口不一致,而出口隔离报告正是按实测 IP 分组。
   */
  const egress = new EgressService({
    timeouts: {
      headersTimeoutMs: config.gateway.headersTimeoutMs,
      bodyTimeoutMs: config.gateway.bodyTimeoutMs,
    },
  });

  /*
   * 配置读取做成函数,让热更新后下一个请求即生效。
   *
   * Phase 3 还没有改配置的入口,所以这里返回的始终是启动时那份;
   * 但把形状定成函数,Phase 9 加管理 API 时就不必回头改所有调用点。
   */
  const app = createApp({
    configOf: () => config,
    egress,
    log: (message) => console.error(message),
  });

  /*
   * 端口:ZG_PORT 覆盖配置。
   *
   * 两个来源都要认。配置里的 `gateway.port` 是用户的正式设置;而 ZG_PORT
   * 让测试能把端口与 `ZG_DATA_DIR` 一起隔离 —— service.mjs 的注释已说明
   * 那不是为测试开的后门,而是让「误杀无关进程」「restart 谎报成功」这类
   * 缺陷能有常驻回归测试的前提。
   *
   * **service.mjs 必须按同一优先级解析端口**,否则它会去探一个没人监听的
   * 端口,然后在健康等待超时后报「启动失败」,而服务其实已经起来了。
   * 我这一版最初只读配置、丢掉了 ZG_PORT,`service.mjs` 的 6 条集成测试
   * 因此全红 —— 两处的优先级必须一致。
   */
  const envPort = process.env["ZG_PORT"];
  let port = config.gateway.port;
  if (envPort !== undefined && envPort !== "") {
    const parsed = Number(envPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`ZG_PORT 不是合法端口:${envPort}`);
      process.exitCode = 1;
      return;
    }
    port = parsed;
  }

  /*
   * 仅 loopback 监听。
   *
   * 管理面另有 loopbackOnly 中间件独立把关(监听地址是可配的,
   * 而管理面任何情况下都不该接受远端)。
   */
  const hostname = "127.0.0.1";

  /*
   * 端口被占时给一句能自查的话。
   *
   * 默认行为是 Node 抛未捕获的 EADDRINUSE 并打出一整段栈 —— 那对用户毫无
   * 帮助,而这是最常见的启动失败(上一个实例还活着)。
   */
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`zen-gateway 已启动 → http://${hostname}:${info.port}`);
    if (created) {
      console.log("已生成默认配置与 Relay Token;运行 npm run status 查看。");
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。可能上一个实例仍在运行(npm run status 查看)。`);
    } else {
      console.error(`监听失败:${err.message}`);
    }
    process.exit(1);
  });

  const shutdown = async (): Promise<void> => {
    // 关掉 dispatcher 池,避免 keep-alive 连接把进程吊住。
    await egress.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

await main();
