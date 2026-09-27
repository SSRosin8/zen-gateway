import { serve } from "@hono/node-server";
import { buildHealth, createApp } from "./app.ts";
import { loadConfig, saveConfig } from "../store/config.ts";
import type { Config } from "../shared/schema.ts";
import { resolveAdminPort, resolvePort } from "../store/port.ts";
import { EgressService } from "../core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../core/models/catalog.ts";
import { ProtocolDeclarations } from "../core/models/protocols.ts";
import { ConfigError } from "../store/config.ts";
import { Scheduler } from "../core/routing/scheduler.ts";
import { openRuntimeDb } from "../store/db/open.ts";
import { StatsStore } from "../store/db/stats.ts";
import { AffinityStore } from "../store/db/affinityStore.ts";
import { BatchProbeStore } from "../store/db/batchProbeStore.ts";
import { BatchProbeRunner } from "./admin/batchRunner.ts";
import { safeErrorMessage } from "../shared/redact.ts";
import { probeBridges } from "../core/proxy/clash/select.ts";
import { ClashController } from "../core/proxy/clash/controller.ts";
import { ensureCatalog } from "./routes/models.ts";
import { probeOpenCodeVersion, writeOpenCodeConfig } from "./admin/opencode.ts";
import { projectRoot } from "../store/paths.ts";
import { createAdminSite, type AdminSite } from "./adminSite.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 服务入口。先加载配置、后监听端口：否则坏配置会先占端口再崩，
 * service.mjs 只能报「启动失败」而不说是配置问题。
 */

async function main(): Promise<void> {
  // 显式标注:`applyConfig` 会重新赋值它,而推断出的类型必须是 Config 而非 any。
  let config: Config;
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
   * 运行时数据库打不开不阻止启动：统计、探测历史与亲和持久化是可用性改善，
   * 不是转发的正确性前提（与配置相反，配置坏了必须拒绝启动）。放在 egress 之前：它要 `probes` sink。
   */
  let stats: StatsStore | undefined;
  let affinityStore: AffinityStore | undefined;
  let batchStore: BatchProbeStore | undefined;
  let db: Awaited<ReturnType<typeof openRuntimeDb>> | undefined;
  try {
    db = await openRuntimeDb();
    stats = new StatsStore(db);
    affinityStore = new AffinityStore(db);
    batchStore = new BatchProbeStore(db);
  } catch (err) {
    console.error(
      `运行时数据库不可用,统计与亲和持久化本次停用(转发不受影响):${safeErrorMessage(err)}`,
    );
  }

  const egress = new EgressService({
    timeouts: {
      headersTimeoutMs: config.gateway.headersTimeoutMs,
      bodyTimeoutMs: config.gateway.bodyTimeoutMs,
    },
    // 探测结果落盘 —— `egressIp` 是出口隔离判定的唯一依据，只活在返回值里就无从复查。
    ...(stats !== undefined ? { probes: stats } : {}),
  });

  /*
   * 调度器在这里建而非由 `createApp` 兜底：它要 `affinityStore` 镜像落盘，装配层不该认识数据库。
   * 出口服务进程内唯一，见 `EgressService.upstreamDeps`。
   */
  const scheduler = new Scheduler(
    affinityStore !== undefined ? { affinitySink: affinityStore } : {},
  );

  /*
   * 在开始监听之前装回上次的亲和绑定，否则重启后头几个请求粘滞失效。
   * 失败只打一行：粘滞从零开始，不影响正确性。
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

  /*
   * 明细表保留期清理：`upstream_attempts` 与 `probe_results` 的毫秒时间戳合起来是一份作息时间线，
   * 聚合信息已在按天的表里，删明细不损失统计。启动时跑一次即可。
   */
  const DETAIL_RETENTION_DAYS = 30;
  if (stats !== undefined) {
    const cutoff = Date.now() - DETAIL_RETENTION_DAYS * 24 * 3_600_000;
    const removed = stats.pruneDetailsBefore(cutoff);
    if (removed > 0) {
      console.log(`已清理 ${removed} 条超过 ${DETAIL_RETENTION_DAYS} 天的明细记录`);
    }
  }

  /*
   * 各 store 的写失败汇合到一处，供 `/health` 报告（`affinityStore` 进了 `Scheduler` 后拿不出来）。
   * 吞掉写失败是对的，但一直写失败的库会安静地给出全 0 报表。
   */
  const storeWriteFailures = (): number => {
    const a = stats?.writeFailures().count ?? 0;
    const b = affinityStore?.writeFailures().count ?? 0;
    const c = batchStore?.writeFailures().count ?? 0;
    return a + b + c;
  };

  const catalog = new ModelCatalog({ log: (message) => console.error(message) });
  const protocols = new ProtocolDeclarations({ log: (message) => console.error(message) });

  /*
   * 配置热更新的唯一写入点。先写盘再换引用：反过来写盘失败会留下「一半生效」。
   * 必须换新对象：`Scheduler.#syncedFrom` 用引用比较判断配置是否变化；
   * `saveConfig` 返回 `ConfigSchema.parse` 的新对象。
   */
  let configWrite: Promise<void> = Promise.resolve();
  // 在 app 装配之后才建；`applyConfig` 先于它声明，所以这里留一个可空引用。
  let adminSite: AdminSite | undefined;
  const applyConfig = async (next: Config, expected?: Config): Promise<void> => {
    const run = configWrite.then(async () => {
      if (expected !== undefined && config !== expected) {
        throw new Error("配置已被另一项操作修改，请刷新页面后重试");
      }
      await saveConfig(next);
      const timeoutsChanged =
        next.gateway.headersTimeoutMs !== config.gateway.headersTimeoutMs ||
        next.gateway.bodyTimeoutMs !== config.gateway.bodyTimeoutMs;
      config = next;
      // 局域网口令开关决定后台页面监听回环还是 0.0.0.0。
      void adminSite?.sync(config.gateway.lanPasswordHash !== null);
      /*
       * 出口缓存失效：Controller 客户端与 dispatcher 按旧 apiBase/apiSecret/超时缓存，必须重建。
       * 失败只记日志，配置已写盘生效。
       */
      try {
        egress.reset(
          timeoutsChanged
            ? { headersTimeoutMs: next.gateway.headersTimeoutMs, bodyTimeoutMs: next.gateway.bodyTimeoutMs }
            : undefined,
        );
      } catch (err) {
        console.error(`出口缓存重置失败(下次请求可能仍用旧连接):${safeErrorMessage(err)}`);
      }
    });
    configWrite = run.catch(() => {});
    await run;
  };

  // 在装配管理 API 之前解析有效端口（含 ZG_PORT 覆盖），让 Overview 与实际监听一致。
  let port: number;
  let adminPort: number;
  try {
    port = resolvePort();
    adminPort = resolveAdminPort();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  /*
   * 批量探测执行器，必须在 `applyConfig` 之后建。启动时先收尾遗留的 `running`
   * （上个进程崩溃留下），标成 `done` 并带 `interrupted`，否则前端永远显示探测中。
   */
  let batchRunner: BatchProbeRunner | undefined;
  if (batchStore !== undefined) {
    const recovered = batchStore.recoverInterrupted(Date.now());
    if (recovered) {
      console.log("上次的批量探测被中断(进程退出),已标记为结束。");
    }
    batchRunner = new BatchProbeRunner({
      configOf: () => config,
      applyConfig,
      egress,
      store: batchStore,
      log: (message) => console.error(message),
      // 批测前探一遍内核并锁定一个；`probeBridges` 只读，不干扰在途转发。
      probeBridges: async () =>
        await probeBridges(
          config.clash.bridges.filter((b) => b.enabled),
          (bridge) => new ClashController(bridge),
          { redact: safeErrorMessage },
        ),
    });
  }

  const openCodeRoot = projectRoot();

  const app = createApp({
    configOf: () => config,
    egress,
    catalog,
    scheduler,
    ...(stats !== undefined ? { stats } : {}),
    storeWriteFailures,
    log: (message) => console.error(message),
    admin: {
      configOf: () => config,
      applyConfig,
      effectivePort: () => port,
      runtimeWorkers: () => scheduler.runtimeWorkers(config, Date.now()),
      catalog,
      protocols,
      // 与转发面同一个实例（不变量 #7 的延伸）。
      egress,
      ...(batchRunner !== undefined ? { batch: batchRunner } : {}),
      // 只读重读：诊断不能顺手修权限，否则「权限过松」永远报不出来。
      diskConfigCheck: async () => (await loadConfig(undefined, { readOnly: true })).permissionIssues,
      ensureCatalog: async () =>
        (await ensureCatalog(config, catalog, (cfg) => egress.upstreamDeps(cfg))).snapshot,
      openCode: { root: openCodeRoot, probeVersion: probeOpenCodeVersion },
      ...(adminPort !== 0 ? { adminPort } : {}),
      // `/health` 的体从同一处构造（纪律 #4）。
      health: () => buildHealth(storeWriteFailures()),
      ...(stats !== undefined ? { stats } : {}),
      log: (message) => console.error(message),
    },
  });

  /*
   * 端口由 `store/port.ts` 单点解析（`ZG_PORT` > `config.gateway.port` > 9876），见上文 `resolvePort`。
   * 仅 loopback 监听；管理面另有 loopbackOnly 独立把关。
   */
  const hostname = "127.0.0.1";

  // 端口被占时给一句能自查的话，而不是 EADDRINUSE 的整段栈。
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`zen-gateway 已启动 → http://${hostname}:${info.port}`);
    // 管理后台页面随网关一起启动（见 adminSite.ts）；`ZG_ADMIN_PORT=0` 关闭（测试用）。
    if (adminPort !== 0) {
      adminSite = createAdminSite({
        root: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "admin"),
        port: adminPort,
        gatewayFetch: app.fetch,
        log: (message) => console.log(message),
      });
      void adminSite.sync(config.gateway.lanPasswordHash !== null);
    }
    if (created) {
      console.log("已生成默认配置与 Relay Token;运行 npm run status 查看。");
      // 首启顺带生成项目级 opencode.json；已有文件绝不覆盖。日志不含 token。
      void writeOpenCodeConfig(
        { root: openCodeRoot, port, relayToken: config.gateway.relayToken, probeVersion: probeOpenCodeVersion },
        { onlyIfMissing: true },
      )
        .then((outcome) => {
          if (!outcome.ok) console.error(`opencode.json 未生成:${outcome.reason}`);
          else if (outcome.action === "created") console.log("已生成项目根 opencode.json(指向本网关)。");
          else console.log("项目根已有 opencode.json,未改动;可在管理后台一键更新。");
        })
        .catch((err) => console.error(`opencode.json 未生成:${safeErrorMessage(err)}`));
    }

    /*
     * 目录预热：在开始监听之后且不 await，免得把启动时间挂在上游响应速度上。
     * 失败无所谓：`/v1/models` 被访问时会再试（`ensure`）。
     */
    catalog.refreshIfStale(
      catalogIdentityOf(config),
      config,
      (cfg) => egress.upstreamDeps(cfg),
    );
    // 模型页的协议声明（models.dev）同样后台预热，失败只记日志，模型页访问时再试。
    void protocols.refreshIfStale();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。可能上一个实例仍在运行(npm run status 查看)。`);
    } else {
      console.error(`监听失败:${err.message}`);
    }
    process.exit(1);
  });

  /*
   * 优雅停机：停止接受新连接 → 限时排空 → 超时强断客户端连接与出口池 → 关库 → 退出。
   * 限时低于 `service.mjs` 的 10 秒停止等待。重复信号复用同一次停机。
   */
  let stopping: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      // 先等 HTTP 服务排空再关出口:undici 的池一旦开始 close 就无法再被 destroy,
      // 超时路径需要当前池仍可强断。
      const drained = Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), adminSite?.close()])
        .then(() => egress.close())
        .then(() => true);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_MS);
      });
      const clean = await Promise.race([drained, timedOut]);
      clearTimeout(timer);
      if (!clean) {
        console.error(`停机等待在途请求超过 ${SHUTDOWN_DRAIN_MS / 1000}s,强制断开剩余连接`);
        closeAllConnections(server);
        egress.destroy();
      }
      try {
        db?.close();
      } catch (err) {
        console.error(`关闭运行时数据库失败:${safeErrorMessage(err)}`);
      }
      process.exit(0);
    })();
    return stopping;
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

/** 停机时等待在途请求排空的上限。须低于 `scripts/service.mjs` 的 10 秒停止等待。 */
const SHUTDOWN_DRAIN_MS = 5_000;

/** `serve()` 的返回类型是 http/http2 服务的联合;只有 http 服务有这个方法。 */
function closeAllConnections(server: object): void {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    (server.closeAllConnections as () => void).call(server);
  }
}

await main();
