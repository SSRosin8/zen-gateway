import type { Config } from "../../shared/schema.ts";
import { RoutingConfigSchema } from "../../shared/schema.ts";
import { shouldCooldown } from "../failures.ts";
import type { AttemptRecord } from "../upstream/retry.ts";
import { AffinityMap } from "./affinity.ts";
import type { AffinitySink, RestoredBinding } from "./affinity.ts";
import { WorkerPool } from "./workerPool.ts";
import { select, type Selection } from "./select.ts";

/**
 * 调度器：把 `workerPool` / `cooldown` / `affinity` / `select` 装成一个对象并独占进程内调度状态，
 * 集中它们的次序约束（选前 sync、流结束后结算、绑定与冷却看同一个 `now`）。路由层只见
 * `plan` → `record` → `settleStream`。进程内唯一：两份冷却状态会让冷却取决于请求走到哪份。
 */

/** 亲和 TTL 兜底值，从 schema 默认值推导（纪律 #4）；仅在从未 sync 过配置时生效。 */
const DEFAULT_AFFINITY_TTL_MS = RoutingConfigSchema.parse({}).affinityTtlMs;

export type ScheduleContext = {
  readonly config: Config;
  readonly now: number;
  /** 已哈希的会话键;拿不到会话标识时为 null。 */
  readonly sessionHash: string | null;
  /** 请求体里加密推理块的 sha256 指纹。 */
  readonly blobHashes: readonly string[];
};

export class Scheduler {
  #pool = new WorkerPool();
  #affinity: AffinityMap;
  /** 上一次 sync 的配置引用：热更新必然产生新对象，引用比较足够且避免每请求深比较。 */
  #syncedFrom: Config | null = null;

  /** 最近一次 sync 的亲和 TTL，供签名里没有 config 的 `rebind`/`settleStream` 使用。 */
  #ttlMs: number = DEFAULT_AFFINITY_TTL_MS;

  /** 注入以便测试断言确切的冷却时长。 */
  readonly #jitter: () => number;

  /** 传入 `affinitySink` 则亲和绑定镜像落盘，否则纯内存。 */
  constructor(opts?: { jitter?: () => number; affinitySink?: AffinitySink }) {
    this.#jitter = opts?.jitter ?? Math.random;
    this.#affinity = new AffinityMap(opts?.affinitySink);
  }

  /** 启动时把持久化的亲和绑定装回内存；须按 `at` 升序（见 `AffinityMap.restore`）。 */
  restoreAffinity(
    sessions: readonly RestoredBinding[],
    blobs: readonly RestoredBinding[],
  ): void {
    this.#affinity.restore(sessions, blobs);
  }

  /** 排出候选链并落下会话绑定。 */
  plan(ctx: ScheduleContext): Selection {
    this.#ensureSynced(ctx.config);
    return select({
      pool: this.#pool,
      config: ctx.config,
      now: ctx.now,
      affinity: {
        map: this.#affinity,
        sessionHash: ctx.sessionHash,
        blobHashes: ctx.blobHashes,
      },
    });
  }

  /**
   * 记一次尝试的结局，由 `retry.ts` 的 `onAttempt` 逐次调用。`now` 是尝试结束时刻
   * （一次尝试可耗数分钟，用开始时刻会把冷却算进过去）。
   *
   * - 成功 → `markSuccess`
   * - 不归咎 Worker 或该类别不冷却 → 不改任何状态：既不升级退避，也不打断真实故障的
   *   连续计数；`unknown` 的 blameWorker 为 true，所以必须同时看 `shouldCooldown`（纪律 #4）
   * - 其余 → `markFailure`
   */
  record(record: AttemptRecord, config: Config, now: number): void {
    this.#ensureSynced(config);

    if (record.failure === null) {
      // 发起时刻 = 记账时刻 − 耗时，供 `markSuccess` 判断；耗时非有限则退回 now。
      const startedAt = Number.isFinite(record.latencyMs) ? now - record.latencyMs : now;
      this.#pool.markSuccess(record.workerId, startedAt);
      return;
    }

    if (!record.blameWorker || !shouldCooldown(record.failure)) return;

    this.#pool.markFailure({
      workerId: record.workerId,
      kind: record.failure,
      retryAfter: record.retryAfter,
      config,
      now,
      jitter: this.#jitter(),
    });
  }

  /**
   * 链 settled 后把会话改绑到实际承接的 Worker：「w1 429 → w2 成功」时推理块由 w2 签发，
   * 绑定停在 w1 会让冷却结束后的回放被上游拒。不放在 `settleStream`：客户端提前断开时
   * 那里不触发。只在成功时调用。
   */
  rebind(sessionHash: string | null, workerId: string, now: number): void {
    if (sessionHash === null) return;
    if (!this.#pool.has(workerId)) return;
    this.#affinity.bindSession(sessionHash, workerId, now, this.#ttlMs);
  }

  /**
   * 不变量 #3：流结束后的亲和结算。
   * - 检出失效推理：解绑会话 + 忘掉指纹，免得下一轮回到必败 Worker
   * - 2xx 且完整读完：学习指纹 → 该 Worker
   * - 不完整（断流/客户端取消）：既不学也不忘，上游可能在未读部分拒绝，而 ESC 中断与推理有效性无关
   * 会话绑定由 `rebind` 处理。
   */
  settleStream(input: {
    /** 承接本次请求的 Worker；失败路径传 null（只有 2xx 的学习分支用它，勿编造值）。 */
    readonly workerId: string | null;
    readonly sessionHash: string | null;
    readonly blobHashes: readonly string[];
    readonly status: number;
    /** 流中检出了失效推理的措辞。 */
    readonly staleHit: boolean;
    /** 流被完整读完(未被上游中断,也未被下游取消)。 */
    readonly complete: boolean;
    readonly now: number;
  }): void {
    if (input.staleHit) {
      if (input.sessionHash !== null) this.#affinity.unbindSession(input.sessionHash);
      this.#affinity.forgetBlobs(input.blobHashes);
      return;
    }

    if (!input.complete) return;
    if (input.status < 200 || input.status >= 300) return;
    if (input.blobHashes.length === 0) return;
    if (input.workerId === null) return;

    this.#affinity.learnBlobs(input.blobHashes, input.workerId, input.now, this.#ttlMs);
  }

  /**
   * 管理 API 用的 Worker 运行期状态，只承诺配置里没有的字段；不直接暴露 `snapshot()`，
   * 免得诊断导出的形状悄悄改掉 API 契约。
   */
  runtimeWorkers(config: Config, now: number): Array<{
    id: string;
    ready: boolean;
    cooldownRemainingMs: number;
    consecutiveFails: number;
    lastFailure: string | null;
  }> {
    this.#ensureSynced(config);
    return this.#pool.snapshot(now).map((w) => ({
      id: w.id,
      ready: w.ready,
      cooldownRemainingMs: w.cooldownRemainingMs,
      consecutiveFails: w.consecutiveFails,
      lastFailure: w.lastFailure,
    }));
  }

  /** 供诊断导出。不含 apiKey。 */
  snapshot(config: Config, now: number): {
    workers: ReturnType<WorkerPool["snapshot"]>;
    affinity: { sessions: number; blobs: number };
  } {
    this.#ensureSynced(config);
    return {
      workers: this.#pool.snapshot(now),
      affinity: this.#affinity.sizes(),
    };
  }

  /** 丢掉过期与指向已删除 Worker 的亲和条目。仍无生产调用点，理由见 `AffinityMap.prune`。 */
  prune(config: Config, now: number): void {
    this.#ensureSynced(config);
    this.#affinity.prune(now, config.routing.affinityTtlMs, (id) => this.#pool.has(id));
  }

  #ensureSynced(config: Config): void {
    if (this.#syncedFrom === config) return;
    this.#pool.sync(config);
    this.#ttlMs = config.routing.affinityTtlMs;
    this.#syncedFrom = config;
  }
}
