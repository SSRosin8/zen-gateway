import type { Config, RoutingStrategy, WorkerKind } from "../../shared/schema.ts";
import type { AttemptTarget } from "../upstream/retry.ts";
import { isUsable, isWorkerReady, WorkerPool, type WorkerRuntime } from "./workerPool.ts";
import { AffinityMap, digestOf, normalizeSessionKey } from "./affinity.ts";

/**
 * Worker 选择：把冷却、粘滞、策略合成一条有序候选链，`retry.ts` 只需按序走。
 *
 * 排序（优先级从高到低）：
 *   1. 粘滞命中且就绪的 Worker（不被策略抢占）
 *   2. 其余就绪 Worker，按策略排序
 *   3. 一个都不就绪时，只给最早恢复的那一个
 *
 * 有就绪的就只用就绪的：把冷却中的排进链尾会违反冷却（尤其 429 的 Retry-After）；
 * 全员冷却时给一个最接近恢复的，让客户端拿到真实上游错误而非网关自造的 503。
 */

/** 策略 → 优先的 Worker 类别;`null` 表示不排序(按配置顺序)。 */
function preferredKind(strategy: RoutingStrategy): WorkerKind | null {
  switch (strategy) {
    case "anonymous_first":
      return "anonymous";
    case "authenticated_first":
      return "authenticated";
    case "mixed":
      return null;
    default: {
      const exhaustive: never = strategy;
      throw new Error(`未处理的调度策略:${String(exhaustive)}`);
    }
  }
}

function toTarget(worker: WorkerRuntime): AttemptTarget {
  return { workerId: worker.id, apiKey: worker.apiKey, proxyId: worker.proxyId };
}

/** 本次选择用到的亲和上下文。全部可缺 —— 缺了就退化成纯策略排序。 */
export type AffinityContext = {
  readonly map: AffinityMap;
  /** 已归一化并哈希的会话键;拿不到会话标识时为 null。 */
  readonly sessionHash: string | null;
  /** 请求体里加密推理块的 sha256 指纹。 */
  readonly blobHashes: readonly string[];
};

export type SelectInput = {
  readonly pool: WorkerPool;
  readonly config: Config;
  readonly now: number;
  readonly affinity?: AffinityContext;
};

/** 选择结果。`reason` 只用于诊断,不参与任何判断。 */
export type Selection = {
  readonly targets: readonly AttemptTarget[];
  /** 链首 Worker 是怎么定下来的。 */
  readonly reason: "sticky" | "blob_hint" | "strategy" | "all_cooling" | "empty";
  /** 命中粘滞时是哪个 Worker,便于日志与诊断头。 */
  readonly stickyWorkerId: string | null;
};

/**
 * 排出候选链。有副作用：选择时即写会话绑定（而非成功后），让同一会话的并发 turn 落到
 * 同一个 Worker；被绑 Worker 进入冷却后 `lookupSession` 查不到它，自动重挑。
 * TTL 滑动：每次选择重写绑定时间，活跃长对话永不中途换 Worker（否则回放的推理块被上游拒）。
 */
export function select(input: SelectInput): Selection {
  const { pool, config, now } = input;
  const all = pool.all();
  if (all.length === 0) {
    return { targets: [], reason: "empty", stickyWorkerId: null };
  }

  const ttlMs = config.routing.affinityTtlMs;
  const exists = (id: string): boolean => pool.has(id);
  // 就绪判定走唯一定义 `isWorkerReady`，不手写 `<= now`（纪律 #4）。
  const ready = all.filter((w) => isWorkerReady(w.cooldownUntil, now));

  // 1. 粘滞
  let sticky: WorkerRuntime | null = null;
  let reason: Selection["reason"] = "strategy";
  /** 会话绑定的 Worker，可能正在冷却；保留供第 3 步判断，不立刻解绑。 */
  let boundId: string | null = null;

  const ctx = input.affinity;
  if (ctx !== undefined && ctx.sessionHash !== null) {
    boundId = ctx.map.lookupSession(ctx.sessionHash, now, ttlMs, exists);
    /*
     * 绑定就绪则严格粘滞；在冷却则放弃粘滞重挑，不等待（冷却可达 15 分钟）也不解绑：
     * 第 4 步的 bind(head) 会覆盖它，而第 3 步需要它还在。
     */
    if (boundId !== null && pool.isReady(boundId, now)) {
      sticky = pool.get(boundId);
      reason = "sticky";
    }
  }

  // 2. 推理指纹提示（仅在没有会话绑定时）
  if (sticky === null && ctx !== undefined && ctx.blobHashes.length > 0) {
    const hinted = ctx.map.findBlobWorker(ctx.blobHashes, now, ttlMs, exists);
    if (hinted !== null && pool.isReady(hinted, now)) {
      sticky = pool.get(hinted);
      reason = "blob_hint";
    }
  }

  // 3. 全员冷却：只给最早恢复的那一个，且不动会话绑定
  if (ready.length === 0) {
    const earliest = all.reduce((best, w) => (w.cooldownUntil < best.cooldownUntil ? w : best));

    /*
     * 刻意不 bind：否则一次短暂的全员冷却就把会话绑定永久迁离签发推理块的 Worker，
     * 而第 2 步的指纹提示在会话命中时不会被查。若本轮成功，`relay.ts` 的 `rebind()`
     * 会把绑定落到实际承接者。选最早恢复者是「违反冷却最轻」的选择。
     */
    return {
      targets: [toTarget(earliest)],
      reason: "all_cooling",
      stickyWorkerId: null,
    };
  }

  // 4. 就绪的按策略排序，粘滞的提到最前
  const preferred = preferredKind(config.routing.strategy);
  const ordered =
    preferred === null
      ? [...ready]
      : // 稳定排序，同类别内保持用户配置顺序。
        [...ready].sort((a, b) => rank(a, preferred) - rank(b, preferred));

  const targets =
    sticky === null
      ? ordered.map(toTarget)
      : [toTarget(sticky), ...ordered.filter((w) => w.id !== sticky.id).map(toTarget)];

  const head = targets[0];
  if (head !== undefined) bind(ctx, head.workerId, now, ttlMs);

  return { targets, reason, stickyWorkerId: sticky?.id ?? null };
}

function rank(worker: WorkerRuntime, preferred: WorkerKind): number {
  return worker.kind === preferred ? 0 : 1;
}

function bind(
  ctx: AffinityContext | undefined,
  workerId: string,
  now: number,
  ttlMs: number,
): void {
  if (ctx === undefined || ctx.sessionHash === null) return;
  ctx.map.bindSession(ctx.sessionHash, workerId, now, ttlMs);
}

/**
 * 从请求体与客户端头解析会话哈希，体内标识（Responses 的 `previous_response_id`）优先于
 * `x-opencode-session` 头。客户端没发该头时网关合成的值每请求不同，粘滞自然失效（正确）。
 */
export function sessionHashFrom(input: {
  readonly bodyKey: string | undefined;
  readonly headerValue: string | undefined;
}): string | null {
  const raw = normalizeSessionKey(input.bodyKey) ?? normalizeSessionKey(input.headerValue);
  return raw === null ? null : digestOf(raw);
}

/** 不含调度状态的候选链，供目录查询用；刻意不共用转发的 WorkerPool，免得只读查询影响冷却。 */
export function usableTargets(config: Config): AttemptTarget[] {
  return config.workers.filter(isUsable).map((w) => ({
    workerId: w.id,
    apiKey: w.apiKey,
    proxyId: w.proxyId,
  }));
}

/** 供诊断:说明为何没有候选。 */
export function describeNoWorker(config: Config): string {
  if (config.workers.length === 0) {
    return "尚未配置任何 Worker";
  }
  const enabled = config.workers.filter((w) => w.enabled);
  if (enabled.length === 0) {
    return "所有 Worker 都已停用";
  }
  return "所有已启用的 Worker 都缺少上游 API key";
}
