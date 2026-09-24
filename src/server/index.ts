import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "../store/config.ts";
import { resolvePort } from "../store/port.ts";
import { EgressService } from "../core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../core/models/catalog.ts";
import { ConfigError } from "../store/config.ts";
import { Scheduler } from "../core/routing/scheduler.ts";
import { openRuntimeDb } from "../store/db/open.ts";
import { StatsStore } from "../store/db/stats.ts";
import { AffinityStore } from "../store/db/affinityStore.ts";
import { safeErrorMessage } from "../shared/redact.ts";

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
  /*
   * 运行时数据库（Phase 7）。
   *
   * ## 打不开**不阻止启动**
   *
   * 统计与亲和持久化都是**可用性改善**，不是转发的正确性前提：
   * 前者是诊断设施，后者只影响「重启后要不要重挑一次 Worker」。
   * 一个坏掉的统计库（磁盘满、档位高于本程序、文件权限错）让整个网关
   * 起不来是错误的取舍 —— 用户要的是转发能用。
   *
   * 所以这里失败只打一行可自查的话然后继续，`stats`/`affinitySink`
   * 保持未注入，转发路径退回纯内存（Phase 6 的行为）。
   *
   * 与 `loadConfig` 的处置刻意不同：配置坏了**必须**拒绝启动，
   * 因为那意味着凭证、出口绑定、放行规则都是未知的 —— 那是正确性。
   */
  let stats: StatsStore | undefined;
  let affinityStore: AffinityStore | undefined;
  try {
    const db = await openRuntimeDb();
    stats = new StatsStore(db);
    affinityStore = new AffinityStore(db);
  } catch (err) {
    console.error(
      `运行时数据库不可用,统计与亲和持久化本次停用(转发不受影响):${safeErrorMessage(err)}`,
    );
  }

  /*
   * 调度器在这里建，而不是让 `createApp` 兜底 new 一个 ——
   * 它需要拿到 `affinityStore` 才能镜像落盘，而装配层不该认识数据库。
   */
  const scheduler = new Scheduler(
    affinityStore !== undefined ? { affinitySink: affinityStore } : {},
  );

  /*
   * 装回上次的亲和绑定。
   *
   * **在开始监听之前**做完：装载是同步的本地读，很快；而若放在监听之后，
   * 头几个请求会看到一张空表，于是刚重启的那一刻粘滞失效 ——
   * 那正是持久化要解决的问题本身。
   *
   * 失败只打一行：内存里那份是空的，行为退回 Phase 6，不影响正确性。
   */
  if (affinityStore !== undefined) {
    try {
      const now = Date.now();
      // 先清过期行，再读 —— 少读一批马上会被内存判废的条目。
      affinityStore.pruneExpired(now);
      const sessions = affinityStore.loadSessions(now);
      const blobs = affinityStore.loadBlobs(now);
      scheduler.restoreAffinity(sessions, blobs);
      if (sessions.length > 0 || blobs.length > 0) {
        console.log(`已恢复亲和绑定:会话 ${sessions.length} 条、推理指纹 ${blobs.length} 条`);
      }
    } catch (err) {
      console.error(`亲和绑定恢复失败,本次从空表开始:${safeErrorMessage(err)}`);
    }
  }

  const catalog = new ModelCatalog({ log: (message) => console.error(message) });

  const app = createApp({
    configOf: () => config,
    egress,
    catalog,
    scheduler,
    ...(stats !== undefined ? { stats } : {}),
    log: (message) => console.error(message),
  });

  /*
   * 端口由 `store/port.ts` 单点解析 —— `ZG_PORT` > `config.gateway.port` > 9876。
   *
   * 这里刻意**不**自己读 `config.gateway.port`,尽管配置已在内存里:端口先前在
   * 三处各自手写解析(本文件、`service.mjs`、`vite.config.ts`),而 Phase 3 就因
   * 两处脱节炸过一次 —— 我把监听端口改成读配置却没同步脚本,脚本于是去探一个
   * 没人监听的端口,健康等待超时后报「启动失败」,而服务其实已经起来了。
   * 第三处(vite 代理)到 2026-09-23 梳理时还是硬编码的 9876。
   *
   * 必须在 `loadConfig()` **之后**调用:首启时那一步才会把默认配置落盘。
   */
  let port: number;
  try {
    port = resolvePort();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
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

    /*
     * 目录预热 —— 在**开始监听之后**,且刻意不 await。
     *
     * 顺序要紧:预热要发网络请求,而它放在 `listen` 之前会把启动时间挂在
     * 上游的响应速度上。`service.mjs` 的健康等待有超时,于是一次上游慢响应
     * 会被报成「启动失败」,而服务其实完全正常 —— 那正是 Phase 3 端口脱节
     * 时踩过的同一种误报。
     *
     * 失败无所谓:`refreshIfStale` 自己吞异常并记失败时刻,而
     * `/v1/models` 被访问时会再试一次(`ensure`)。预热只是让**第一个**
     * 转发请求就能享受交集,而不是等到有人先去拉一次模型列表。
     */
    catalog.refreshIfStale(
      catalogIdentityOf(config),
      config,
      (cfg) => egress.upstreamDeps(cfg),
    );
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
