import { serve } from "@hono/node-server";
import { buildHealth, createApp } from "./app.ts";
import { loadConfig, saveConfig } from "../store/config.ts";
import type { Config } from "../shared/schema.ts";
import { resolvePort } from "../store/port.ts";
import { EgressService } from "../core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../core/models/catalog.ts";
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

/**
 * 服务入口。
 *
 * 启动顺序刻意如下:**先加载配置,后监听端口**。
 * 反过来的话,一份坏配置会让服务先占住端口再崩,而 service.mjs 的健康等待
 * 会在超时后报「启动失败」,却不说是配置的问题 —— 用户拿不到可自查的信息。
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
   * 运行时数据库。**打不开不阻止启动。**
   *
   * 统计、探测历史与亲和持久化都是**可用性改善**，不是转发的正确性前提。
   * 一个坏掉的统计库（磁盘满、档位高于本程序、权限错）让整个网关起不来
   * 是错误的取舍 —— 用户要的是转发能用。失败只打一行然后继续，
   * 三个 sink 保持未注入，行为等同于没有持久化的纯内存网关。
   *
   * 与 `loadConfig` 刻意相反：配置坏了**必须**拒绝启动，因为那意味着凭证、
   * 出口绑定、放行规则都是未知的 —— 那是正确性。
   *
   * 放在 egress **之前**：`EgressService` 要拿 `probes` sink。
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
   * 出口服务在进程内**唯一** —— 见 `EgressService.upstreamDeps`：
   * Clash selector 的 `now` 是进程外的全局状态，两套锁会让探测量到的出口
   * 与转发实际用的出口不一致，而出口隔离报告正是按实测 IP 分组。
   *
   * 配置读取做成函数，让热更新后下一个请求即生效，调用点不必各自感知热更新。
   *
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
   * 失败只打一行：内存里那份是空的，只是粘滞从零开始，不影响正确性。
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
   * 明细表的保留期清理。
   *
   * `upstream_attempts` 与 `probe_results` 的每行带**毫秒级时间戳**，合起来
   * 是一份作息时间线（哪天几点在工作、连续多久）—— 在「意外把文件复制/
   * 打包出去」这个威胁下比聚合值敏感得多。容量本身不是问题（约 47 MB/年）。
   *
   * 聚合所需的信息已在 `worker_stats` 与 `model_usage` 里（按天，不按毫秒），
   * 所以删明细不损失统计能力。`secure_delete = ON` 保证删掉的页真被擦掉，
   * 否则「已经清过了」是个假保证。
   *
   * 30 天：够排查「上周那次限流是怎么回事」，又不至于攒成一年的时间线。
   * 启动时跑一次即可 —— 这是个自用工具，不值得养一个 interval。
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
   * 统计/持久化的写失败**汇合到一处报告**。
   *
   * 两个 store 各有一个 `writeFailures()`，而 `affinityStore` 被塞进
   * `Scheduler` 的构造参数后就再也拿不出来 —— 而 doctor 要报这些数，
   * 进程里必须有一处同时持有全部引用。这里持有它们，`/health` 读这个函数。
   *
   * 吞掉写失败是对的（诊断设施不该让转发失败），但**吞掉不等于可以不知道**：
   * 一个一直写失败的库会安静地给出全 0 报表，而那看起来像「没人用」。
   */
  const storeWriteFailures = (): number => {
    const a = stats?.writeFailures().count ?? 0;
    const b = affinityStore?.writeFailures().count ?? 0;
    const c = batchStore?.writeFailures().count ?? 0;
    return a + b + c;
  };

  const catalog = new ModelCatalog({ log: (message) => console.error(message) });

  /*
   * 配置热更新的**唯一**写入点。
   *
   * `configOf()` 是函数，但只有这里会改它指向的对象 —— 没有这个入口，
   * 它返回的恒是启动时那份，「热更新只有形状没有入口」。
   *
   * ## 顺序刻意是「先写盘，再换引用」
   *
   * 反过来的话，一次写盘失败（磁盘满、权限）会留下**内存已生效而磁盘是旧值**
   * 的状态：界面显示改动生效了，而下次重启退回旧值。「一半生效」比「没生效」
   * 难查得多 —— 用户会怀疑是自己改错了别的地方。
   *
   * ## 必须换一个**新对象**
   *
   * `Scheduler.#syncedFrom` 用**引用比较**判断「配置换了没有」（深比较一份含
   * 512 个 Worker 的配置要跑在每个请求上）。原地改字段会让引用不变 →
   * 调度器认为配置没换 → Worker 池不重新 sync → 改了配置下一个请求还在用旧的池，
   * 而这个偏差**不报任何错**。`saveConfig` 返回的是 `ConfigSchema.parse` 的
   * 结果（新对象），`applyConfigPatch` 也 `structuredClone` 过，两处都成立。
   */
  let configWrite: Promise<void> = Promise.resolve();
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
      /*
       * 出口缓存失效。
       *
       * `EgressService` 按 bridgeId 缓存 Controller 客户端、按节点名缓存
       * dispatcher，而 `apiBase`/`apiSecret` 变了必须重建 —— 否则会继续连旧地址
       * 或用旧凭证，症状是「密码明明改对了还是 401」。超时变了则新池带新超时。
       *
       * 失败(停机中服务已关闭)只记日志:配置已经写盘生效,这一点不该被它推翻。
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

  /*
   * 在装配管理 API 之前解析有效端口，让 Overview 与真正监听的端口共享同一
   * 个值（包括 ZG_PORT 覆盖）。resolvePort 仍然在 loadConfig 之后调用，首启
   * 默认配置已在那一步落盘。
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
   * 批量探测的执行器。
   *
   * **必须在 `applyConfig` 之后建**：它要拿那个函数把实测 IP 写回配置。
   *
   * 启动时先收尾遗留状态:崩溃或 `kill -9` 会让库里留下 `running`,而那批探测
   * **已经不在跑了**（它活在上一个进程里）。不收尾的话前端永远显示「探测中…」、
   * 按钮永远禁用,唯一出路是手工改库。标成 `done` 且带 `interrupted` ——
   * 静默标成 idle 会让用户以为那批探测正常完成了。
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
      /*
       * 批测前探一遍内核并锁定一个。
       *
       * `probeBridges` 只读 `/version` 与 `/proxies`，不改任何状态，
       * 所以能并发、也不会干扰在途的转发。
       */
      probeBridges: async () =>
        await probeBridges(
          config.clash.bridges.filter((b) => b.enabled),
          (bridge) => new ClashController(bridge),
          { redact: safeErrorMessage },
        ),
    });
  }

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
      // 与转发面同一个实例 —— 两套 dispatcher 池/selector 锁会让探测量到的出口
      // 不是转发实际用的那个(不变量 #7 的延伸)。
      egress,
      ...(batchRunner !== undefined ? { batch: batchRunner } : {}),
      /*
       * `/health` 的体从同一处构造 —— 不在两个地方各拼一份。
       *
       * 两份会分叉（纪律 #4），而分叉方向是漏：加一个字段时 `/api/overview`
       * 里那份不会更新，于是管理面显示的健康信息比 `/health` 旧一个版本。
       */
      health: () => buildHealth(storeWriteFailures()),
      ...(stats !== undefined ? { stats } : {}),
      log: (message) => console.error(message),
    },
  });

  /*
   * 端口由 `store/port.ts` 单点解析 —— `ZG_PORT` > `config.gateway.port` > 9876。
   *
   * 这里刻意**不**自己读 `config.gateway.port`,尽管配置已在内存里:本文件、
   * `service.mjs`、`vite.config.ts` 若各自手写解析,任意两处脱节都会让脚本去探
   * 一个没人监听的端口,健康等待超时后报「启动失败」,而服务其实已经起来了。
   *
   * 必须在 `loadConfig()` **之后**调用:首启时那一步才会把默认配置落盘。
   */
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
     * 会被报成「启动失败」,而服务其实完全正常 —— 与端口脱节是同一种误报。
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

  /*
   * 优雅停机:停止接受新连接 → 限时等在途请求与出口连接排空 → 超时就强断 →
   * 关库 → 退出。
   *
   * 限时低于 `service.mjs` 的 10 秒停止等待:一条长 SSE 可能持续几分钟,
   * 无限期等待会让 `npm run stop` 报「未响应 SIGTERM」。超时后先断客户端连接,
   * 客户端取消会沿请求链传到上游;再 destroy 出口池,收拾余下的上游连接。
   * 热更新换下、仍在排空的旧池无法从外部强断,由随后的进程退出结束。
   *
   * 重复信号(SIGTERM 后又按 Ctrl-C)复用同一次停机,不重入。
   */
  let stopping: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      // 先等 HTTP 服务排空再关出口:undici 的池一旦开始 close 就无法再被 destroy,
      // 超时路径需要当前池仍可强断。
      const drained = new Promise<void>((resolve) => server.close(() => resolve()))
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
