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
import { safeErrorMessage } from "../shared/redact.ts";

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
   * 三个 sink 保持未注入，行为退回 Phase 6。
   *
   * 与 `loadConfig` 刻意相反：配置坏了**必须**拒绝启动，因为那意味着凭证、
   * 出口绑定、放行规则都是未知的 —— 那是正确性。
   *
   * 放在 egress **之前**：`EgressService` 要拿 `probes` sink。
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

  const egress = new EgressService({
    timeouts: {
      headersTimeoutMs: config.gateway.headersTimeoutMs,
      bodyTimeoutMs: config.gateway.bodyTimeoutMs,
    },
    // 探测结果落盘 —— `egressIp` 是出口隔离判定的唯一依据，而先前它只活在返回值里。
    ...(stats !== undefined ? { probes: stats } : {}),
  });

  /*
   * 出口服务在进程内**唯一** —— 见 `EgressService.upstreamDeps`：
   * Clash selector 的 `now` 是进程外的全局状态，两套锁会让探测量到的出口
   * 与转发实际用的出口不一致，而出口隔离报告正是按实测 IP 分组。
   *
   * 配置读取做成函数，让热更新后下一个请求即生效（Phase 9 加管理 API 时
   * 不必回头改所有调用点）。
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
   * `Scheduler` 的构造参数后就再也拿不出来 —— 第七轮审核指出这是个会在
   * Phase 8 才发现的装配问题（doctor 要报两个数，而进程里没有地方同时
   * 持有两个引用）。现在这里持有它们，`/health` 读这个函数。
   *
   * 吞掉写失败是对的（诊断设施不该让转发失败），但**吞掉不等于可以不知道**：
   * 一个一直写失败的库会安静地给出全 0 报表，而那看起来像「没人用」。
   */
  const storeWriteFailures = (): number => {
    const a = stats?.writeFailures().count ?? 0;
    const b = affinityStore?.writeFailures().count ?? 0;
    return a + b;
  };

  const catalog = new ModelCatalog({ log: (message) => console.error(message) });

  /*
   * 配置热更新的**唯一**写入点（Phase 9，缺口 #1 到期）。
   *
   * `configOf()` 从 Phase 3 起就是函数，但先前没有任何东西会改它指向的对象 ——
   * 所以它返回的恒是启动时那份，「热更新只有形状没有入口」。
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
  const applyConfig = async (next: Config): Promise<void> => {
    await saveConfig(next);
    config = next;
    /*
     * 出口缓存失效。
     *
     * `EgressService` 按 bridgeId 缓存 Controller 客户端、按节点名缓存
     * dispatcher，而 `apiBase`/`apiSecret` 变了必须重建 —— 否则会继续连旧地址
     * 或用旧凭证，症状是「密码明明改对了还是 401」。`reset()` 正是为此存在的
     * （它的注释写着「配置变更后让缓存失效」），而在 Phase 9 之前
     * **没有任何调用点**。
     *
     * 不 await 也不吞掉:它只关连接池,失败不影响配置已经生效这个事实,
     * 但要能被看见。
     */
    egress.reset().catch((err) => {
      console.error(`出口缓存重置失败(下次请求可能仍用旧连接):${safeErrorMessage(err)}`);
    });
  };

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
      runtimeWorkers: () => scheduler.runtimeWorkers(config, Date.now()),
      catalog,
      // 与转发面同一个实例 —— 两套 dispatcher 池/selector 锁会让探测量到的出口
      // 不是转发实际用的那个(不变量 #7 的延伸)。
      egress,
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
