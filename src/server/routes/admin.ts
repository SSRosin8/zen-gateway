import { Hono } from "hono";
import type { Config } from "../../shared/schema.ts";
import {
  BatchProbeRequestSchema,
  StatsResetRequestSchema,
  BatchProgressSchema,
  ConfigPatchSchema,
  ModelListSchema,
  OverviewSchema,
  ProxyListSchema,
  StatsViewSchema,
  SubscriptionRefreshSchema,
  type Overview,
  type StatsView,
} from "../../shared/contract.ts";
import { poolHealth } from "../../shared/contract.ts";
import { buildIsolationReport } from "../../core/proxy/probe.ts";
import type { EgressService } from "../../core/proxy/egress.ts";
import { judgeFree } from "../../core/models/free.ts";
import { catalogIdentityOf, slotOf, type CatalogSnapshot, type ModelCatalog } from "../../core/models/catalog.ts";
import type { ProtocolDeclarations } from "../../core/models/protocols.ts";
import type { VersionProbe } from "../admin/opencode.ts";
import { createClashRoutes } from "./admin/clash.ts";
import { createDiagnosticsRoutes } from "./admin/diagnostics.ts";
import { createOpenCodeRoutes } from "./admin/opencode.ts";
import { probeExclusive } from "./admin/probe.ts";
import { adminError, issuesText, MAX_ADMIN_BODY_BYTES, readJsonBody } from "./admin/common.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { dayKey } from "../../store/db/stats.ts";
import { applyConfigPatch } from "../admin/patch.ts";
import { BodyTooLargeError, readBoundedBody } from "../boundedBody.ts";
import {
  clashView,
  displayFingerprint,
  isolationEntries,
  modelViews,
  poolCounts,
  proxySummary,
  proxyViews,
  subscriptionViews,
  workerViews,
  type RuntimeWorkerState,
} from "../admin/project.ts";
import type { BatchProbeRunner } from "../admin/batchRunner.ts";
import { fetchSubscription, type FetchDeps } from "../../core/proxy/subscription/fetch.ts";
import { importSubscriptionNodes } from "../../core/proxy/subscription/import.ts";

/**
 * 管理 API。三条硬规则：
 * 1. 凭证绝不出进程：响应全部经 `admin/project.ts` 投影，只输出 `SecretPresence`。
 * 2. 仅回环：由 `app.ts` 挂的 `loopbackOnly` 判定，本文件不另判断来源（纪律 #4）。
 * 3. 写入原子且可回退：合并结果先全量过 `ConfigSchema`，再经 `saveConfig` 原子写。
 * 每个读 body 的端点都必须过 1 MiB 闸门；转发面的 64 MiB 是为多模态留的。
 */

/** 统计默认回看天数。全量扫是唯一随行数线性变慢的聚合，所以默认带 sinceDay。 */
const DEFAULT_STATS_DAYS = 30;

export type AdminStatsSource = {
  modelUsage(sinceDay?: string): StatsView["models"];
  workerTotals(): StatsView["workers"];
  rates(sinceDay?: string): StatsView["rates"];
  rejectionsByReason(sinceDay?: string): Record<string, number>;
  rejectedModels(sinceDay?: string): Array<{ reason: string; model: string; count: number }>;
  daily(sinceDay?: string): StatsView["daily"];
  reset(): number;
  requestCounts(sinceDay?: string): { requests: number; attempts: number };
  modelProtocols(sinceDay?: string): ReadonlyMap<string, readonly string[]>;
};

export type AdminDeps = {
  readonly configOf: () => Config;
  /**
   * 落盘并让进程内所有读者立刻看到新配置；由持有可变引用的 `index.ts` 提供。
   * 必须换新对象：`Scheduler.#syncedFrom` 用引用比较判断配置是否变化。
   */
  readonly applyConfig: (next: Config, expected?: Config) => Promise<void>;
  /** 实际监听端口（含 ZG_PORT 覆盖），而不是配置文件里的默认值。 */
  readonly effectivePort: () => number;
  /** 调度器的运行期状态。只要这一小片 —— 见 `RuntimeWorkerState`。 */
  readonly runtimeWorkers: () => readonly RuntimeWorkerState[];
  readonly catalog: ModelCatalog;
  /** models.dev 协议声明缓存，只供模型页展示；不传则所有模型显示「未声明」。 */
  readonly protocols?: ProtocolDeclarations;
  /**
   * 出口服务，必须与转发面共用同一个（见 `EgressService.upstreamDeps`），
   * 否则探测量到的出口与转发实际用的不一致。不传则 `/probe` 不可用。
   */
  readonly egress?: EgressService;
  /** 批量探测执行器；需要打开的数据库，不在装配层兜底造。不传则端点报不可用。 */
  readonly batch?: BatchProbeRunner;
  readonly health: () => Overview["health"];
  readonly stats?: AdminStatsSource;
  /** 只读重读磁盘配置并返回权限问题，供诊断；不传则诊断的配置层只报内存状态。 */
  readonly diskConfigCheck?: () => Promise<readonly string[]>;
  /** 按 `/v1/models` 同一路径取目录，供诊断；不传则目录层跳过。 */
  readonly ensureCatalog?: () => Promise<CatalogSnapshot | null>;
  /** 项目根与 opencode 版本探测；不传则 `/opencode*` 报不可用。测试注入临时目录与假探测。 */
  readonly openCode?: { readonly root: string; readonly probeVersion: VersionProbe };
  /** 订阅拉取注入点。生产走 `globalThis.fetch`，刻意不经出口 dispatcher 池。 */
  readonly subscriptionFetch?: FetchDeps;
  /** 后台页面的实际端口（`resolveAdminPort`）；用于给出局域网访问地址。不传则不列地址。 */
  readonly adminPort?: number;
  readonly log?: (message: string) => void;
};

export function createAdminRoutes(deps: AdminDeps): Hono {
  /*
   * 实测协议来自 `upstream_attempts` 明细的 DISTINCT 扫描（同步、无覆盖索引），而模型页每 30 秒轮询一次。
   * 这个集合只在出现新的 2xx 模型 × 协议组合时才变，缓存一分钟足够新，也把扫描频率降到轮询的一半以下。
   */
  let protocolCache: { since: string; at: number; value: ReadonlyMap<string, readonly string[]> } | null = null;
  const measuredProtocols = (since: string): ReadonlyMap<string, readonly string[]> => {
    const now = Date.now();
    if (protocolCache !== null && protocolCache.since === since && now - protocolCache.at < 60_000 && now >= protocolCache.at) {
      return protocolCache.value;
    }
    const value = deps.stats!.modelProtocols(since);
    protocolCache = { since, at: now, value };
    return value;
  };
  const app = new Hono();

  /** 正在刷新的订阅 id，按 id 进程内互斥：不同订阅并发刷新是安全的。 */
  const refreshing = new Set<string>();

  app.route("/", createClashRoutes(deps));
  app.route("/", createDiagnosticsRoutes(deps));
  app.route("/", createOpenCodeRoutes(deps));

  /** 探针；`assertEveryRouteGuarded` 的测试依赖它。 */
  app.get("/ping", (c) => c.json({ ok: true }));

  /** Overview 聚合端点：页面上每个数字必须来自同一时刻的状态。 */
  app.get("/overview", (c) => {
    const config = deps.configOf();
    const views = workerViews(config, deps.runtimeWorkers());
    const counts = poolCounts(views);
    const report = buildIsolationReport(isolationEntries(views));

    /*
     * 目录只读缓存，绝不发请求。拉不到时 `freeCount` 为 null 而不是 0：
     * 「还没拿到目录」与「一个免费模型都没有」是两件事。
     */
    const identity = catalogIdentityOf(config);
    const snapshot = deps.catalog.cached(slotOf(identity));
    const freeCount =
      snapshot === null
        ? null
        : snapshot.entries.filter((e) => judgeFree(e.id, config.models, snapshot).free).length;

    const body: Overview = {
      health: deps.health(),
      gateway: {
        port: deps.effectivePort(),
        baseUrl: config.gateway.baseUrl,
        relayToken: displayFingerprint(config.gateway.relayToken),
        maxAttempts: config.gateway.maxAttempts,
        headersTimeoutMs: config.gateway.headersTimeoutMs,
        bodyTimeoutMs: config.gateway.bodyTimeoutMs,
      },
      routing: {
        strategy: config.routing.strategy,
        affinityTtlMs: config.routing.affinityTtlMs,
        cooldown: { ...config.routing.cooldown },
      },
      pool: { ...counts, health: poolHealth(counts) },
      workers: views,
      isolation: {
        groups: report.groups,
        unknownWorkerIds: report.unknownWorkerIds,
        sharedGroups: report.sharedGroups,
        isolated: report.isolated,
      },
      catalog: { slots: deps.catalog.status(), freeCount },
      clash: clashView(config),
      proxies: proxySummary(config.proxies),
    };

    // 过 schema 再返回：契约变化在服务端立刻失败，而不是在浏览器里 parse 失败。
    return c.json(OverviewSchema.parse(body));
  });

  /**
   * 统计。`days` 默认 30：`requestCounts` 的 `COUNT(DISTINCT request_id)` 随行数线性变慢，
   * 且同步调用会阻塞事件循环。
   */
  app.get("/stats", (c) => {
    if (deps.stats === undefined) {
      // 统计库不可用时不假装有数据：返回全 0 会让「库坏了」看起来像「没人用」。
      return adminError(c, "internal_error", "统计库不可用,本次未加载统计(转发不受影响)");
    }

    const daysRaw = c.req.query("days");
    let sinceDay: string | null = null;
    if (daysRaw !== "all") {
      const days = Number(daysRaw ?? DEFAULT_STATS_DAYS);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return adminError(c, "invalid_request", "days 必须是 1-3650 的整数,或 all");
      }
      sinceDay = dayKey(Date.now() - (days - 1) * 86_400_000);
    }

    const since = sinceDay ?? undefined;
    const body: StatsView = {
      sinceDay,
      ...deps.stats.requestCounts(since),
      models: deps.stats.modelUsage(since),
      workers: deps.stats.workerTotals(),
      rates: deps.stats.rates(since),
      rejections: deps.stats.rejectionsByReason(since),
      rejectedModels: deps.stats.rejectedModels(since),
      daily: deps.stats.daily(since),
    };
    return c.json(StatsViewSchema.parse(body));
  });

  /**
   * 清空用量统计（`StatsStore.reset`）。不可撤销，前端先确认。不影响转发、探测历史与会话亲和。
   * 请求体必须是 `{ "confirm": true }`：一个没带体的误触 POST 不该清库。
   */
  app.post("/stats/reset", async (c) => {
    const body = await readJsonBody(c, StatsResetRequestSchema);
    if (!body.ok) return body.response;
    if (deps.stats === undefined) return adminError(c, "internal_error", "统计库不可用");
    try {
      const removed = deps.stats.reset();
      deps.log?.(`用量统计已重置(删除 ${removed} 行)`);
      return c.json({ ok: true, removed });
    } catch (err) {
      return adminError(c, "write_failed", `重置失败:${safeErrorMessage(err)}`);
    }
  });

  /**
   * 改配置：有界读体 → patch schema → 纯函数合并（全量 `ConfigSchema` 与引用完整性）→ 原子写 → 换引用。
   * 任何一步失败都不落盘，且 404/422/500 分开报。
   */
  app.patch("/config", async (c) => {
    let raw: Uint8Array;
    try {
      // 有界读取：chunked 请求没有 content-length，只能边读边数。见 `boundedBody.ts`。
      raw = await readBoundedBody(c.req.raw, MAX_ADMIN_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return adminError(c, "invalid_request", "请求体超过上限(1 MiB)");
      }
      deps.log?.(`管理面读请求体失败: ${safeErrorMessage(err)}`);
      return adminError(c, "invalid_request", "无法读取请求体");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // 不回显请求体:它含 apiKey。
      return adminError(c, "invalid_request", "请求体不是合法 JSON");
    }

    const patch = ConfigPatchSchema.safeParse(parsed);
    if (!patch.success) {
      return adminError(c, "invalid_request", issuesText(patch.error.issues));
    }

    const result = applyConfigPatch(deps.configOf(), patch.data);
    if (!result.ok) {
      return adminError(c, result.failure.kind, result.failure.message);
    }

    // 没有实际变化就不写盘，也不触发一次无谓的 Worker 池 re-sync。
    if (!result.changed) {
      return c.json({ ok: true, changed: false });
    }

    try {
      await deps.applyConfig(result.config, deps.configOf());
    } catch (err) {
      // 写盘失败时进程内配置也不换，`applyConfig` 先写盘成功再换引用（见 `index.ts`）。
      deps.log?.(`配置写入失败: ${safeErrorMessage(err)}`);
      return adminError(c, "write_failed", `配置写入失败:${safeErrorMessage(err)}`);
    }

    return c.json({ ok: true, changed: true });
  });

  /**
   * 探测在用的出口并把实测 IP 写回配置：隔离报告按 `config.proxies[].egressIp` 分组，
   * 只探测不写回则隔离永远无法成立。探测走服务自己的 `EgressService`（不变量 #7 的延伸）。
   * 同步返回，默认探在用出口，可用 `proxyIds` 指定；几十个节点的批测走 `/batch-probe`。
   * 与批量探测互斥（都要切 selector），进行中回 409。
   */
  app.post("/probe", async (c) => await probeExclusive(c, deps));

  /**
   * 刷新一个订阅：`fetchSubscription`（多 UA 协商）→ `parseSubscription` → `importSubscriptionNodes`，这里只接线并写盘。
   * 同一订阅单飞：并发刷新各自读旧配置合并，后写的会覆盖先写的新增节点。
   * 失败也写回 `lastErrorKind`；`lastFetchedAt` 只在成功时更新。
   */
  app.post("/subscriptions/:id/refresh", async (c) => {
    const id = c.req.param("id");
    const config = deps.configOf();
    const subscription = config.subscriptions.find((s) => s.id === id);
    if (subscription === undefined) {
      return adminError(c, "not_found", `没有 id 为 ${id} 的订阅`);
    }

    if (refreshing.has(id)) {
      // 409：与批量探测的并发 start 同一个语义 —— 不排队，让调用方重试。
      return adminError(c, "conflict", "该订阅正在刷新中");
    }
    refreshing.add(id);

    try {
      const outcome = await fetchSubscription(subscription.url, deps.subscriptionFetch ?? {});

      // 重读配置：拉取期间用户可能改过配置。
      const fresh = deps.configOf();
      const touch = (extra: Partial<(typeof fresh.subscriptions)[number]>) => ({
        ...fresh,
        subscriptions: fresh.subscriptions.map((s) => (s.id === id ? { ...s, ...extra } : s)),
      });

      if (!outcome.ok) {
        try {
          await deps.applyConfig(touch({ lastErrorKind: outcome.kind }), fresh);
        } catch (err) {
          deps.log?.(`订阅状态写入失败: ${safeErrorMessage(err)}`);
        }
        deps.log?.(`订阅刷新失败(${id}): ${outcome.kind}`);
        return c.json(
          SubscriptionRefreshSchema.parse({
            ok: false,
            failureKind: outcome.kind,
            reason: outcome.reason,
            format: null,
            added: 0,
            updated: 0,
            removed: 0,
            keptBecauseInUse: 0,
            disabledNeedBridge: 0,
            skipped: 0,
          }),
        );
      }

      const merged = importSubscriptionNodes(fresh, id, outcome.result.nodes);
      const withMeta = {
        ...merged.config,
        subscriptions: merged.config.subscriptions.map((s) =>
          s.id === id
            ? {
                ...s,
                lastFetchedAt: new Date().toISOString(),
                lastErrorKind: null,
                lastImportCount: outcome.result.nodes.length,
                lastFormat: outcome.result.format,
              }
            : s,
        ),
      };

      try {
        await deps.applyConfig(withMeta, fresh);
      } catch (err) {
        deps.log?.(`订阅导入写入失败: ${safeErrorMessage(err)}`);
        return adminError(c, "write_failed", `拉取成功但写入失败：${safeErrorMessage(err)}`);
      }

      deps.log?.(
        `订阅刷新(${id}): ${outcome.result.format} · +${merged.summary.added} ~${merged.summary.updated} -${merged.summary.removed} · UA=${outcome.userAgent}`,
      );

      return c.json(
        SubscriptionRefreshSchema.parse({
          ok: true,
          failureKind: null,
          reason: null,
          format: outcome.result.format,
          added: merged.summary.added,
          updated: merged.summary.updated,
          removed: merged.summary.removed,
          keptBecauseInUse: merged.summary.keptBecauseInUse.length,
          disabledNeedBridge: merged.summary.disabledNeedBridge,
          skipped: outcome.result.skipped,
        }),
      );
    } finally {
      refreshing.delete(id);
    }
  });

  /** 代理池聚合端点：代理列表、Clash 状态与隔离报告必须来自同一时刻。 */
  app.get("/proxies", (c) => {
    const config = deps.configOf();
    const views = workerViews(config, deps.runtimeWorkers());
    const report = buildIsolationReport(isolationEntries(views));

    return c.json(
      ProxyListSchema.parse({
        proxies: proxyViews(config),
        clash: clashView(config),
        isolation: {
          groups: report.groups,
          unknownWorkerIds: report.unknownWorkerIds,
          sharedGroups: report.sharedGroups,
          isolated: report.isolated,
        },
        subscriptions: subscriptionViews(config),
      }),
    );
  });

  /**
   * 模型列表，只读缓存。目录拿不到时 `catalogAvailable: false`：
   * 「拿不到目录」与「目录为空」的下一步不同。
   */
  app.get("/models", (c) => {
    const config = deps.configOf();
    const snapshot = deps.catalog.cached(slotOf(catalogIdentityOf(config)));
    // 协议声明只读缓存；过期就后台刷新，本次响应不等它（第三方慢不能拖住模型页）。
    void deps.protocols?.refreshIfStale();
    const declared = deps.protocols?.cached() ?? null;
    // 实测窗口与统计页默认范围一致，且带 sinceDay，免得全表扫阻塞事件循环。
    let measuredSinceDay: string | null = null;
    let measured: ReadonlyMap<string, readonly string[]> = new Map();
    if (deps.stats !== undefined) {
      const since = dayKey(Date.now() - (DEFAULT_STATS_DAYS - 1) * 86_400_000);
      try {
        measured = measuredProtocols(since);
        measuredSinceDay = since;
      } catch (err) {
        // 统计库坏了不该让模型页整页失败；窗口报 null（与库不可用同一种界面），原因进日志。
        deps.log?.(`模型页实测协议查询失败: ${safeErrorMessage(err)}`);
      }
    }

    return c.json(
      ModelListSchema.parse({
        models: modelViews(config, snapshot, { declared, measured }),
        catalogAvailable: snapshot !== null,
        protocolSource: {
          available: declared !== null,
          fetchedAt: declared === null ? null : new Date(declared.fetchedAt).toISOString(),
        },
        measuredSinceDay,
        rules: {
          freeSuffix: config.models.freeSuffix,
          extraFreeIds: config.models.extraFreeIds,
          catalogTtlMs: config.models.catalogTtlMs,
          enforceCatalog: config.models.enforceCatalog,
        },
      }),
    );
  });

  /* ---------------- 批量探测（长任务） ---------------- */

  /**
   * 当前进度，前端轮询。进度归服务端所有：探测仍在跑时刷新页面不能丢掉真相，
   * 否则用户会再点开始，造成两批并发互换出口节点。
   */
  app.get("/batch-probe", (c) => {
    if (deps.batch === undefined) {
      return adminError(c, "internal_error", "批量探测不可用(统计库未就绪)");
    }
    return c.json(batchProgressView(deps.batch));
  });

  /**
   * 控制批量探测。四个动作是同一状态机的输入，合法性在 reducer 一处判断
   * （不合法转移返回原状态，不抛）。
   */
  app.post("/batch-probe", async (c) => {
    // 体积闸门排在可用性检查之前：是否读入大 body 不该取决于 runner 状态。
    const body = await readJsonBody(c, BatchProbeRequestSchema);
    if (!body.ok) return body.response;
    const { action } = body.data;

    if (deps.batch === undefined) {
      return adminError(c, "internal_error", "批量探测不可用(统计库未就绪)");
    }

    switch (action) {
      case "start": {
        const started = deps.batch.start({ createWorkers: body.data.createWorkers === true });
        if (!started) {
          // 409 不排队：两批并发会互相切 selector；也可能是没有可探的出口（`batchTargets` 为空）。
          return c.json(
            {
              error: {
                type: "invalid_config",
                message: "已有一批探测或出口探测在进行中，或没有可探的出口（没有已启用的节点，也没有在用的本机直连）",
              },
            },
            409,
          );
        }
        break;
      }
      case "pause":
        deps.batch.pause();
        break;
      case "resume":
        deps.batch.resume();
        break;
      case "cancel":
        deps.batch.cancel();
        break;
    }

    return c.json(batchProgressView(deps.batch));
  });

  return app;
}

function batchProgressView(batch: BatchProbeRunner) {
  const startedAt = batch.startedAt();
  return BatchProgressSchema.parse({
    ...batch.snapshot(),
    nodes: batch.nodes(),
    // 从未跑过 → null，而不是 0：「没开始」与「刚开始」是两件事。
    elapsedMs: startedAt === null ? null : Math.max(0, Date.now() - startedAt),
  });
}
