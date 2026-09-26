import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import {
  BatchProgressSchema,
  ConfigPatchSchema,
  ModelListSchema,
  OverviewSchema,
  ProbeReportSchema,
  ProxyListSchema,
  StatsViewSchema,
  SubscriptionRefreshSchema,
  type Overview,
  type StatsView,
  AdminErrorSchema,
  type AdminErrorType,
} from "../../shared/contract.ts";
import { poolHealth } from "../../shared/contract.ts";
import { buildIsolationReport } from "../../core/proxy/probe.ts";
import { applyProbeResults, type EgressService } from "../../core/proxy/egress.ts";
import { judgeFree } from "../../core/models/free.ts";
import { catalogIdentityOf, slotOf, type ModelCatalog } from "../../core/models/catalog.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { dayKey } from "../../store/db/stats.ts";
import { applyConfigPatch } from "../admin/patch.ts";
import { BodyTooLargeError, readBoundedBody } from "../boundedBody.ts";
import {
  clashView,
  displayFingerprint,
  isolationEntries,
  isUsable,
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
 * 管理 API。
 *
 * ## 三条硬规则
 *
 * 1. **凭证绝不出进程。** 全部响应经 `admin/project.ts` 投影，那里是唯一
 *    读凭证字段的地方，且只输出 `SecretPresence`（有没有 + 8 位指纹）。
 * 2. **仅回环。** `app.ts` 给 `/api/*` 挂了 `loopbackOnly`，它只读内核报告的
 *    TCP 对端地址、绝不采信 `X-Forwarded-For`。本文件不再自己判断来源 ——
 *    两份判断必然分叉（纪律 #4）。
 * 3. **写入必须原子且可回退。** 复用 `saveConfig`（临时文件 → fsync →
 *    rename，0600 一出生就有），并在写之前把合并结果全量过一遍 `ConfigSchema`。
 *
 * ## 管理面的 body 上限
 *
 * 安全约束里有一条「管理 JSON 请求体有上限；relay 透传对多模态保持
 * 无界」。管理侧每个读 body 的端点都必须过闸门，否则这条约束会静默变成「不成立」。
 *
 * 上限 1 MiB：一份含 512 个 Worker 的配置补丁实测不到 100 KB，而转发面的
 * 64 MiB 是为多模态留的，管理面没有那个需求。
 */

/** 管理请求体上限。与 relay 的 64 MiB 刻意不同 —— 见文件头。 */
const MAX_ADMIN_BODY_BYTES = 1024 * 1024;

/** 统计默认回看天数。全量扫是唯一随行数线性变慢的聚合，所以默认带 sinceDay。 */
const DEFAULT_STATS_DAYS = 30;

export type AdminStatsSource = {
  modelUsage(sinceDay?: string): StatsView["models"];
  workerTotals(): StatsView["workers"];
  rates(sinceDay?: string): StatsView["rates"];
  rejectionsByReason(sinceDay?: string): Record<string, number>;
  requestCounts(sinceDay?: string): { requests: number; attempts: number };
};

export type AdminDeps = {
  readonly configOf: () => Config;
  /**
   * 落盘并**让进程内所有读者立刻看到新配置**。
   *
   * 由 `index.ts` 提供 —— 它是唯一持有那个可变引用的地方。`configOf()` 是函数，
   * 但没有这个入口就没有任何东西会改它指向的对象，它返回的恒是启动时那份。
   *
   * **必须换一个新对象**而不是原地改：`Scheduler.#syncedFrom` 用引用比较
   * 判断「配置换了没有」，原地改会让 Worker 池不重新 sync。
   */
  readonly applyConfig: (next: Config, expected?: Config) => Promise<void>;
  /** 实际监听端口（含 ZG_PORT 覆盖），而不是配置文件里的默认值。 */
  readonly effectivePort: () => number;
  /** 调度器的运行期状态。只要这一小片 —— 见 `RuntimeWorkerState`。 */
  readonly runtimeWorkers: () => readonly RuntimeWorkerState[];
  readonly catalog: ModelCatalog;
  /**
   * 出口服务。**必须与转发面共用同一个** —— 见 `EgressService.upstreamDeps`：
   * selector 的 `now` 是进程外全局状态，两套锁会让探测量到的出口与转发实际
   * 用的那个不一致，而隔离报告正是按实测 IP 分组。不传则 `/probe` 不可用。
   */
  readonly egress?: EgressService;
  /**
   * 批量探测的执行器。不传则那两个端点报不可用。
   *
   * 它需要一个打开的数据库（进度要持久化），所以与 `stats` 同理由
   * **不在装配层兜底造一个**。
   */
  readonly batch?: BatchProbeRunner;
  readonly health: () => Overview["health"];
  readonly stats?: AdminStatsSource;
  /**
   * 订阅拉取的注入点。测试用它喂一个假 fetch。
   *
   * 生产不传 —— 走 `globalThis.fetch`。**刻意不经 dispatcher 池**:
   * 订阅是从机场拉配置，不是发上游请求，不该占用出口代理，
   * 也不该因为某个 Worker 的出口坏了就拉不到订阅。
   */
  readonly subscriptionFetch?: FetchDeps;
  readonly log?: (message: string) => void;
};

function adminError(c: Context, type: AdminErrorType, message: string) {
  const status = {
    invalid_request: 400,
    invalid_config: 422,
    write_failed: 500,
    not_found: 404,
    internal_error: 500,
  }[type] as 400 | 404 | 422 | 500;
  /*
   * 过一遍 `AdminErrorSchema` 而不是手工拼装。
   *
   * 手工拼装的话，schema 描述的形状与这里手写的对象各存一份，
   * 于是「改了枚举而忘了改 handler」不会有任何症状。
   * 经它构造则是构造期抛错，与其余管理端点一致。
   */
  return c.json(AdminErrorSchema.parse({ error: { type, message } }), status);
}

export function createAdminRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  /**
   * 正在刷新的订阅 id —— 进程内互斥，见 `/subscriptions/:id/refresh`。
   *
   * 按 id 而不是全局：两个不同订阅并发刷新是安全的（它们只动自己的节点），
   * 而全局锁会让"刷新全部"变成串行，那没必要。
   */
  const refreshing = new Set<string>();

  /**
   * 探针。保留 —— `assertEveryRouteGuarded` 的测试依赖它，
   * 而且它是「管理面仅回环」这条约束最小的验证目标。
   */
  app.get("/ping", (c) => c.json({ ok: true }));

  /**
   * Overview —— 一个请求给完这一页要的全部东西。
   *
   * 刻意做成聚合端点而不是六个小端点：这一页每个数字都来自**同一时刻**的
   * 状态，分六个请求拿会让「3 个 Worker / 2 个就绪 / 隔离成立」这三句话
   * 描述三个不同瞬间的系统 —— 而它们会被当成一句话读。
   */
  app.get("/overview", (c) => {
    const config = deps.configOf();
    const views = workerViews(config, deps.runtimeWorkers());
    const counts = poolCounts(views);
    const report = buildIsolationReport(isolationEntries(views));

    /*
     * 目录**只读缓存,绝不发请求**。
     *
     * 与转发路径同一条规则:管理面刷新一次页面不该触发一次上游查询 ——
     * 那会让打开后台变成一个有网络依赖的动作,而目录本来就有后台刷新
     * (`refreshIfStale`)在维护。拉不到时 `freeCount` 为 **null 而不是 0**:
     * 「还没拿到目录」与「一个免费模型都没有」是两件事,后者才需要排查。
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

    /*
     * 走一遍 schema 再返回。
     *
     * 契约变了这里立刻失败,而不是让 admin 在浏览器里 parse 失败 ——
     * 与 `/health` 同一个做法。代价是一次序列化校验,对一个本机管理端点可忽略。
     */
    return c.json(OverviewSchema.parse(body));
  });

  /**
   * 统计。
   *
   * `days` 查询参数默认 30:`requestCounts` 的 `COUNT(DISTINCT request_id)`
   * 是**唯一随行数线性变慢**的聚合(实测 100k 行 12.4ms、1M 行约 124ms),
   * 而它是**同步**调用 —— 不带 sinceDay 会阻塞事件循环那么久。
   * 所以管理 API 总是传它。
   */
  app.get("/stats", (c) => {
    if (deps.stats === undefined) {
      /*
       * 统计库不可用时**不假装有数据**。
       *
       * `index.ts` 刻意让库打不开也不阻止启动(转发是正确性,统计是可用性改善),
       * 所以这条路径真实可达。返回全 0 会让「库坏了」看起来像「没人用」——
       * 那正是 `storeWriteFailures` 存在要防的同一种误导。
       */
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
    };
    return c.json(StatsViewSchema.parse(body));
  });

  /**
   * 改配置。
   *
   * 整个流程:读体(有上限)→ 过 patch schema → 纯函数合并
   * (含全量 `ConfigSchema` 与引用完整性)→ 原子写 → 换进程内引用。
   *
   * **任何一步失败都不落盘**,而且失败类型区分开 —— 「id 打错了」(404)与
   * 「合并后配置非法」(422)与「磁盘写不动」(500)的下一步完全不同。
   */
  app.patch("/config", async (c) => {
    let raw: Uint8Array;
    try {
      /*
       * **有界读取**。不能「查 content-length + 读完再量」：
       * `transfer-encoding: chunked` 根本不给那个头，于是整条检查被绕过。
       * 所以边读边数，理由见 `server/boundedBody.ts`。
       */
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
      return adminError(
        c,
        "invalid_request",
        patch.error.issues
          .slice(0, 10)
          .map((i) => `${i.path.map(String).join(".") || "(根)"}: ${i.message}`)
          .join("; "),
      );
    }

    const result = applyConfigPatch(deps.configOf(), patch.data);
    if (!result.ok) {
      return adminError(c, result.failure.kind, result.failure.message);
    }

    /*
     * 没有实际变化就不写盘。
     *
     * 一个空 patch(或把字段改成它已有的值)不该产生一次磁盘写 + 一次
     * Worker 池 re-sync —— 后者会让所有 Worker 的冷却状态走一遍
     * 「保留同 id 状态」的路径,而那条路径在 apiKey 相同时才保留。
     * 无谓地跑它没有收益,只增加一次出错机会。
     */
    if (!result.changed) {
      return c.json({ ok: true, changed: false });
    }

    try {
      await deps.applyConfig(result.config, deps.configOf());
    } catch (err) {
      /*
       * 写盘失败 —— 进程内的配置**也不能换**。
       *
       * 换了的话内存与磁盘不一致:界面显示改动生效了,而下次重启会退回旧值。
       * 「一半生效」比「没生效」更难查,所以 `applyConfig` 的实现必须
       * 先写盘成功再换引用(见 `index.ts`)。
       */
      deps.log?.(`配置写入失败: ${safeErrorMessage(err)}`);
      return adminError(c, "write_failed", `配置写入失败:${safeErrorMessage(err)}`);
    }

    return c.json({ ok: true, changed: true });
  });

  /**
   * 探测出口并**把实测 IP 写回配置**。
   *
   * ## 为什么需要这个端点
   *
   * 没有它，`isolation` 恒为
   * `{ groups: [], unknownWorkerIds: [全部], isolated: false }` —— 出口隔离视图
   * **结构上永远无法成立**。两个原因叠在一起：
   *
   * 1. 只探测不写回的话，`probe_results` 有记录，但 `config.proxies[].egressIp`
   *    从未被写过 —— 把实测 IP 并回 `Proxy` 的只有 `applyProbeResult()`。
   * 2. `doctor.mjs` **自建** `EgressService` 且只读配置
   *    —— 它的实测结果留在自己进程里，服务这边看不到。
   *
   * 于是「按实测 `egressIp` 分组」这条核心要求(出口隔离正是本项目存在的
   * 理由)需要服务侧的数据来源:探测走**服务自己的** `EgressService`
   * (与转发共用同一个 dispatcher 池与 selector 锁 —— 那是不变量 #7 的延伸,
   * 否则量到的出口不是转发实际用的那个),结果经 `applyProbeResult` 并回配置并落盘。
   *
   * ## 同步返回,不做长任务
   *
   * 批量探测是个带状态机的长任务(`idle|screening|running|paused|...`),
   * 见 `/batch-probe`,服务于代理池页。这里是同步版本:只探在用的出口,
   * 个位数节点约 6 秒 —— 一个同步请求可以接受,而 Overview 需要
   * 「点一下就能看到隔离报告」这个最小能力。几十个节点的批测仍走长任务。
   */
  app.post("/probe", async (c) => {
    if (deps.egress === undefined) {
      return adminError(c, "internal_error", "出口服务不可用");
    }

    const config = deps.configOf();
    /*
     * 只探**在用的**出口 —— 按 Worker 实际绑定去重。
     *
     * 探一个没人用的代理没有诊断价值,而每次探测都要真发网络请求
     * (桥接还要切 selector、串行化)。`null` 也在里面:本机直连也是一个出口,
     * 而它与某个代理 NAT 到同一个 IP 恰好是「看起来隔离其实没隔离」的形态。
     */
    const proxyIds = [...new Set(config.workers.filter(isUsable).map((w) => w.proxyId))];
    if (proxyIds.length === 0) {
      return adminError(c, "invalid_config", "没有可用的 Worker,无从探测出口");
    }

    let results;
    try {
      results = await deps.egress.probeAll(config, proxyIds);
    } catch (err) {
      deps.log?.(`出口探测失败: ${safeErrorMessage(err)}`);
      return adminError(c, "internal_error", `探测失败:${safeErrorMessage(err)}`);
    }

    /*
     * 把成功的实测 IP 并回配置。
     *
     * `applyProbeResult` 对失败**不清空**已有 IP —— 一次网络抖动不该让
     * 「这个代理的出口是什么」这条已知事实消失,否则隔离视图会在每次抖动时
     * 把已确认隔离的节点退回「未知」。那条规则在纯函数里,这里只负责接线。
     *
     * ## 合并前必须**重读**配置
     *
     * `probeAll` 实测约 6 秒，那几秒足够用户在 Worker 页改个名并保存。
     * 若用探测**开始前**那份快照，探测返回后写回时会把用户的
     * 改动凭空覆盖掉 —— 响应 200、`changed: true`，没有任何症状。
     *
     * 同一文件的订阅刷新（`POST /subscriptions/:id/refresh`）与
     * `batchRunner.#persist` 也防了这个；三处同类路径必须一致（纪律 #4）。
     */
    const byProxy = new Map(results.map((r) => [r.proxyId, r.outcome] as const));
    /*
     * 走 `applyProbeResults` 而不是自己 map 一遍 proxies —— 它同时处理
     * **本机直连**那条（合成 id `__direct__` → `gateway.directEgressIp`）。
     * 只并 proxies 的话，直连的测量会被静默丢弃。
     */
    const fresh = deps.configOf();
    const merged = applyProbeResults(fresh, byProxy);
    const changed = merged.changed;

    if (changed) {
      try {
        await deps.applyConfig(merged.config, fresh);
      } catch (err) {
        deps.log?.(`探测结果写入失败: ${safeErrorMessage(err)}`);
        return adminError(c, "write_failed", `探测成功但写入失败:${safeErrorMessage(err)}`);
      }
    }

    /*
     * 返回**每个出口的结果**，失败的也要给出原因。
     *
     * 只回「成功几个」会让「为什么那个节点探不出来」无从查证，而那恰好是
     * 用户最需要的信息（例如混合端口配错时全部桥接代理传输失败，
     * 而控制面是通的 —— 只有逐条的 failureKind 能指出方向）。
     */
    /*
     * 过一遍 schema —— 与其余端点一致。
     *
     * 过 schema 挡的不是今天的泄漏
     * （今天没有），而是"将来新增一个字段时忘了想它该不该出去" ——
     * 那种漏洞没有任何症状，响应照常返回，只是多带了一样东西。
     */
    return c.json(
      ProbeReportSchema.parse({
      ok: true,
      changed,
      results: results.map((r) => ({
        proxyId: r.proxyId,
        ...(r.outcome.ok
          ? { ok: true as const, egressIp: r.outcome.egressIp, latencyMs: r.outcome.latencyMs, via: r.outcome.via }
          : { ok: false as const, failureKind: r.outcome.failureKind, reason: r.outcome.reason }),
      })),
      }),
    );
  });

  /**
   * 刷新一个订阅。
   *
   * 三层各司其职：`fetchSubscription` 负责多 UA 协商（网络），
   * `parseSubscription` 负责认格式（纯函数），`importSubscriptionNodes`
   * 负责并进配置（纯函数）。这里只接线，并把结果写盘。
   *
   * ## 单飞：同一个订阅不允许两个刷新并发
   *
   * 与批量探测同一个理由，但成因不同：这里两个并发刷新会**互相覆盖**
   * 配置（各自读一份旧 config、各自算合并、后写的赢），于是先写的那批
   * 新增节点凭空消失。用一个进程内的 id 集合做互斥 —— 与 `BatchProbeRunner`
   * 的 `#running` 同构。
   *
   * ## 失败也要写回 `lastErrorKind`
   *
   * 否则用户点一次"刷新"看到一个报错弹窗，刷新页面后订阅行看起来一切正常
   * —— 而它其实已经连续失败三天了。`lastFetchedAt` 只在成功时更新
   * （它的语义是"最后一次成功拉到"），失败只记 kind。
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
      return c.json({ error: { type: "conflict", message: "该订阅正在刷新中" } }, 409);
    }
    refreshing.add(id);

    try {
      const outcome = await fetchSubscription(subscription.url, deps.subscriptionFetch ?? {});

      /*
       * 无论成功失败都要更新订阅行的元信息 —— 见上文。
       * 注意这里**重新读一次** `configOf()`：拉取期间用户可能改过配置
       * （那几秒足够点一次保存），用启动时那份会把他的改动覆盖掉。
       */
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

  /**
   * 代理池。
   *
   * 与 Overview 一样是**聚合**端点：这一页要同时显示代理列表、Clash 内核状态
   * 与隔离报告，而三者必须来自同一时刻 —— 分开拿会让「这个节点没出口 IP」
   * 与「隔离不成立」描述两个不同瞬间，而它们是同一件事的两面。
   */
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
   * 模型列表。
   *
   * **只读缓存,绝不发请求** —— 与 Overview 同一条规则。目录拿不到时
   * `catalogAvailable: false` 且列表为空，而**不是**返回一个空列表就完事:
   * 「拿不到目录」与「目录里一个模型都没有」的下一步完全不同。
   */
  app.get("/models", (c) => {
    const config = deps.configOf();
    const snapshot = deps.catalog.cached(slotOf(catalogIdentityOf(config)));

    return c.json(
      ModelListSchema.parse({
        models: modelViews(config, snapshot),
        catalogAvailable: snapshot !== null,
        rules: {
          freeSuffix: config.models.freeSuffix,
          extraFreeIds: config.models.extraFreeIds,
          defaultSurfaces: config.models.defaultSurfaces,
          catalogTtlMs: config.models.catalogTtlMs,
          enforceCatalog: config.models.enforceCatalog,
        },
      }),
    );
  });

  /* ---------------- 批量探测（长任务） ---------------- */

  /**
   * 当前进度。前端轮询这个（运行中 500ms / 空闲 5000ms）。
   *
   * 进度归**服务端**所有 —— 刷新页面或关掉再开都能接着看。理由不只是便利:
   * 探测**已经在跑**（在切 selector、在发真实请求），而前端内存里的进度只是
   * 它的倒影。真相放前端意味着刷新之后真相就没了，而那批探测还在跑 ——
   * 用户此时看到「空闲」并再点开始，就会有两批并发互相换出口节点。
   */
  app.get("/batch-probe", (c) => {
    if (deps.batch === undefined) {
      return adminError(c, "internal_error", "批量探测不可用(统计库未就绪)");
    }
    const startedAt = deps.batch.startedAt();
    return c.json(
      BatchProgressSchema.parse({
        ...deps.batch.snapshot(),
        // 从未跑过 → null，而不是 0：「没开始」与「刚开始」是两件事。
        elapsedMs: startedAt === null ? null : Math.max(0, Date.now() - startedAt),
      }),
    );
  });

  /**
   * 控制批量探测。
   *
   * 四个动作走同一个端点而不是四个:它们是**同一个状态机**的输入，
   * 而把状态机的字母表拆成四条路由会让「哪些动作在当前状态下合法」
   * 散落在四个 handler 里。合法性判断在 reducer 一处（不合法的转移
   * 返回原状态，不抛异常 —— 事件来自轮询与点击两个源，可以乱序到达）。
   */
  app.post("/batch-probe", async (c) => {
    /*
     * 体积闸门排在**业务可用性检查之前**。
     *
     * 反过来的话，一个 8 MiB 的请求在 runner 未就绪时会先被完整读进内存
     * 再返回 500 —— 体积闸门存在的理由恰恰是"不要读那么多"，
     * 而它是否生效不该取决于另一个组件的状态。
     *
     * `MAX_ADMIN_BODY_BYTES` 是本文件的常量，每个写端点都必须显式用它：
     * 上限写在调用点而不是闸门上，漏一处就是 8 MiB 的 body 被照常接受。
     */
    let action: string;
    try {
      const raw = await readBoundedBody(c.req.raw, MAX_ADMIN_BODY_BYTES);
      const body = JSON.parse(new TextDecoder().decode(raw)) as { action?: unknown };
      action = String(body.action ?? "");
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return adminError(c, "invalid_request", "请求体超过上限(1 MiB)");
      }
      return adminError(c, "invalid_request", "请求体不是合法 JSON");
    }

    if (deps.batch === undefined) {
      return adminError(c, "internal_error", "批量探测不可用(统计库未就绪)");
    }

    switch (action) {
      case "start": {
        const started = deps.batch.start();
        if (!started) {
          /*
           * 409 而不是静默排队。
           *
           * 两批并发会互相切 selector（进程外全局状态），于是实测到的出口
           * 不是转发实际会用的那个 —— 而隔离报告正按那个 IP 分组。
           * 也可能是「没有可用 Worker」，两种都用 409 但文案不同。
           */
          return c.json(
            {
              error: {
                type: "invalid_config",
                message: "已有一批探测在进行中，或没有可用的 Worker",
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
      default:
        return adminError(c, "invalid_request", "action 必须是 start / pause / resume / cancel");
    }

    const startedAt = deps.batch.startedAt();
    return c.json(
      BatchProgressSchema.parse({
        ...deps.batch.snapshot(),
        // 从未跑过 → null，而不是 0：「没开始」与「刚开始」是两件事。
        elapsedMs: startedAt === null ? null : Math.max(0, Date.now() - startedAt),
      }),
    );
  });

  return app;
}
