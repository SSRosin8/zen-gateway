import type { Config, Worker, WorkerKind } from "../../shared/schema.ts";
import type { FailureKind } from "../failures.ts";
import { cooldownUntil } from "./cooldown.ts";

/**
 * Worker 集合与就绪判定：调度里唯一持有可变状态的部分，让「为什么选了它」可由一次
 * `snapshot()` 完整回答。状态只有 `cooldownUntil` 与 `consecutiveFails`：Worker 是个位数的
 * 手工账号，统计式健康评估只会让行为不可预测。
 */

/** Worker 的运行期状态。对外只读,修改一律经本类的方法。 */
export type WorkerRuntime = {
  readonly id: string;
  readonly kind: WorkerKind;
  readonly apiKey: string;
  readonly proxyId: string | null;
  /** 冷却到此时刻(epoch ms)。0 表示不在冷却。 */
  readonly cooldownUntil: number;
  /** 连续失败次数;成功即清零。 */
  readonly consecutiveFails: number;
  /** 最近一次失败的类别,供诊断展示"为什么在冷却"。 */
  readonly lastFailure: FailureKind | null;
};

/** 被移出候选池(停用/清空 key)的 Worker 留下的状态。 */
type RetiredState = {
  readonly apiKey: string;
  readonly cooldownUntil: number;
  readonly consecutiveFails: number;
  readonly lastFailure: FailureKind | null;
};

/** `#retired` 的容量上限。 */
const RETIRED_CAP = 512;

/**
 * 就绪判定的唯一定义（`isReady`、`snapshot`、`select.ts` 共用，纪律 #4）。
 * NaN 防护在这里：NaN 参与比较恒为 false，会让 Worker 永久不就绪。
 */
export function isWorkerReady(cooldownUntil: number, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(cooldownUntil)) return false;
  return cooldownUntil <= now;
}

/** Worker 是否可用于转发：须 enabled；认证 Worker 须有 key，匿名 Worker 的空 key 合法。 */
export function isUsable(worker: Worker): boolean {
  if (!worker.enabled) return false;
  return worker.kind === "anonymous" || worker.apiKey.trim() !== "";
}

/**
 * 可用 Worker 实际绑定的出口，去重；`null` 表示本机直连，也算一个出口。
 * 单点探测、批量探测与 doctor 共用，探测范围不会分叉（纪律 #4）。
 */
export function usedProxyIds(config: Config): Array<string | null> {
  return [...new Set(config.workers.filter(isUsable).map((w) => w.proxyId))];
}

export class WorkerPool {
  /** 按配置顺序；顺序有意义（`select.ts` 的稳定排序）。 */
  #workers: WorkerRuntime[] = [];

  /**
   * 被过滤掉（停用/清空 key）的 Worker 的状态，让「停用再启用」不抹掉上游要求的冷却。
   * 跨多次 sync 累积，超出上限丢最老的（那个 Worker 回来时从零开始，不是损坏）。
   */
  #retired = new Map<string, RetiredState>();

  constructor(config?: Config) {
    if (config !== undefined) this.sync(config);
  }

  /**
   * 用新配置替换 Worker 列表，保留同 id 的冷却状态（否则热更新变成全员复活）。
   * apiKey 变了才重置：换 key 是用户对「这个账号不能用」的直接回应。出口变化与停用再启用
   * 都不重置（后者从 `#retired` 找回）。
   */
  sync(config: Config): void {
    const previous = new Map(this.#workers.map((w) => [w.id, w] as const));

    // 这一轮不再可用的，状态存进 #retired。
    const nextIds = new Set(config.workers.filter(isUsable).map((w) => w.id));
    for (const w of this.#workers) {
      if (nextIds.has(w.id)) continue;
      this.#retired.delete(w.id); // 先删再插:维持 Map 的插入顺序即 LRU 顺序
      this.#retired.set(w.id, {
        apiKey: w.apiKey,
        cooldownUntil: w.cooldownUntil,
        consecutiveFails: w.consecutiveFails,
        lastFailure: w.lastFailure,
      });
    }
    while (this.#retired.size > RETIRED_CAP) {
      const oldest = this.#retired.keys().next();
      if (oldest.done === true) break;
      this.#retired.delete(oldest.value);
    }

    this.#workers = config.workers.filter(isUsable).map((w) => {
      const prior = previous.get(w.id) ?? this.#retired.get(w.id);
      const keySame = prior !== undefined && prior.apiKey === w.apiKey;
      return {
        id: w.id,
        kind: w.kind,
        apiKey: w.apiKey,
        proxyId: w.proxyId,
        cooldownUntil: keySame ? prior.cooldownUntil : 0,
        consecutiveFails: keySame ? prior.consecutiveFails : 0,
        lastFailure: keySame ? prior.lastFailure : null,
      };
    });

    for (const w of this.#workers) this.#retired.delete(w.id);
  }

  all(): readonly WorkerRuntime[] {
    return this.#workers;
  }

  get(workerId: string): WorkerRuntime | null {
    return this.#workers.find((w) => w.id === workerId) ?? null;
  }

  has(workerId: string): boolean {
    return this.#workers.some((w) => w.id === workerId);
  }

  isReady(workerId: string, now: number): boolean {
    const worker = this.get(workerId);
    return worker !== null && isWorkerReady(worker.cooldownUntil, now);
  }

  /**
   * 记一次成功：清零计数，仅当这次尝试发出于冷却生效之后才解除冷却。`record()` 按响应到达
   * 顺序调用：并发下一次更早发出的慢成功，不能清掉随后 429 设下的冷却。
   * `attemptStartedAt` 由调用方按 `now - latencyMs` 算出，取不到传 `now`。
   */
  markSuccess(workerId: string, attemptStartedAt: number): void {
    this.#update(workerId, (current) => {
      // `>=`：冷却恰好在发起时刻到期，也算发出于冷却之后。
      const startedAfterCooldown =
        Number.isFinite(attemptStartedAt) && attemptStartedAt >= current.cooldownUntil;
      return {
        ...(startedAfterCooldown ? { cooldownUntil: 0 } : {}),
        consecutiveFails: 0,
        lastFailure: null,
      };
    });
  }

  /** 记一次失败并按类别冷却。返回冷却到的时刻；`null` 表示未冷却。 */
  markFailure(input: {
    workerId: string;
    kind: FailureKind;
    retryAfter: string | null;
    config: Config;
    now: number;
    jitter?: number;
  }): number | null {
    const worker = this.get(input.workerId);
    if (worker === null) return null;

    // 计数对任何 kind 都加；不冷却的类别已由 `Scheduler.record()` 拦在前面。
    const consecutiveFails = worker.consecutiveFails + 1;

    const until = cooldownUntil({
      kind: input.kind,
      retryAfter: input.retryAfter,
      consecutiveFails,
      config: input.config.routing.cooldown,
      now: input.now,
      ...(input.jitter !== undefined ? { jitter: input.jitter } : {}),
    });

    this.#update(input.workerId, (current) => ({
      // 取较大值：乱序到达的短冷却不能缩短 429 设下的长冷却。
      cooldownUntil: until === null ? current.cooldownUntil : Math.max(current.cooldownUntil, until),
      consecutiveFails,
      lastFailure: input.kind,
    }));

    return this.get(input.workerId)?.cooldownUntil ?? null;
  }

  /** 供诊断导出。不含 apiKey。 */
  snapshot(now: number): Array<{
    id: string;
    kind: WorkerKind;
    proxyId: string | null;
    ready: boolean;
    cooldownRemainingMs: number;
    consecutiveFails: number;
    lastFailure: FailureKind | null;
  }> {
    return this.#workers.map((w) => ({
      id: w.id,
      kind: w.kind,
      proxyId: w.proxyId,
      ready: isWorkerReady(w.cooldownUntil, now),
      cooldownRemainingMs: Math.max(0, w.cooldownUntil - now),
      consecutiveFails: w.consecutiveFails,
      lastFailure: w.lastFailure,
    }));
  }

  #update(
    workerId: string,
    patch: (current: WorkerRuntime) => Partial<WorkerRuntime>,
  ): void {
    const index = this.#workers.findIndex((w) => w.id === workerId);
    if (index === -1) return;
    const current = this.#workers[index];
    if (current === undefined) return;
    this.#workers[index] = { ...current, ...patch(current) };
  }
}
