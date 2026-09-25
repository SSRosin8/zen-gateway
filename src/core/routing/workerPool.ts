import type { Config, Worker, WorkerKind } from "../../shared/schema.ts";
import type { FailureKind } from "../failures.ts";
import { cooldownUntil } from "./cooldown.ts";

/**
 * Worker 集合与就绪判定 —— 调度状态机里**唯一**持有可变状态的部分。
 *
 * 其余三块(`cooldown` / `affinity` 的判定 / `select`)都是纯函数或纯数据结构,
 * 状态集中在这里一处,是为了让「为什么这次选了它」可以由一次 `snapshot()`
 * 完整回答。把状态与选择混在一个带隐式状态的大 class 里的话,那个问题答不了 —— 状态散落在方法之间,没有任何一处能完整回答它。
 *
 * ## 状态只有两项
 *
 * `cooldownUntil` 与 `consecutiveFails`。没有「健康分」「权重」「滑动窗口」——
 * 本项目的 Worker 数量是个位数(用户手工配置的账号),统计式的健康评估在
 * 这个规模上只会让行为变得无法预测,而用户真正需要的是
 * 「它为什么不用我这个账号」有一句确定的回答。
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

/** `#retired` 的容量上限。见它的声明处说明。 */
const RETIRED_CAP = 512;

/**
 * 就绪判定的**唯一**定义。
 *
 * 先前这个比较在四处各写一遍(`isReady`、`readyCount`、`snapshot`,以及
 * `select.ts` 的候选过滤)。按纪律 #4,并行的判断必然分叉,而分叉方向是漏 ——
 * 将来任何对"就绪"语义的改动(加一个 `disabledUntil`、或把 `<=` 改成 `<`)
 * 只会落在一处。更糟的是 `select.ts` 里**同一个函数**内两份判定并存:
 * 候选过滤用手写的,粘滞校验用 `pool.isReady`。
 *
 * NaN 防护在这里,而不是在每个调用点:`NaN <= now` 与 `x <= NaN` 都是 false,
 * 于是一个 NaN 会让 Worker **永久**不就绪 —— 这正是 `normalizeFails` 注释
 * 描述的那个后果,而它当时只防住了失败计数这一个入口。
 */
export function isWorkerReady(cooldownUntil: number, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  if (!Number.isFinite(cooldownUntil)) return false;
  return cooldownUntil <= now;
}

/**
 * Worker 是否可用于转发。
 *
 * 认证 Worker 必须有上游 key；匿名 Worker 的空 key 是合法的免鉴权请求。
 * 两种类型都要先满足 `enabled`，再进入候选池。按 kind 处理是必要的：
 * 匿名 Worker 的“无 key”正是它与认证 Worker 的行为差异。
 */
export function isUsable(worker: Worker): boolean {
  if (!worker.enabled) return false;
  return worker.kind === "anonymous" || worker.apiKey.trim() !== "";
}

export class WorkerPool {
  /** 按配置顺序。顺序本身有意义 —— 见 `select.ts` 的策略排序。 */
  #workers: WorkerRuntime[] = [];

  /**
   * 被过滤掉(停用/清空 key)的 Worker 的状态。
   *
   * 不留这一份的后果是实测出来的:`sync()` 的 `previous` Map 从 `#workers` 建,
   * 而它已被 `filter(isUsable)` 过滤 —— 停用的 Worker 不在里面。于是
   * 「停用 → 再启用」会让 `prior === undefined`,冷却与失败计数全清。
   * 实测:429 `Retry-After: 900` 之后停用再启用,剩余冷却从 900000ms 变成 0。
   *
   * Phase 9 的管理后台点一下停用再启用就能抹掉上游明确要求的 15 分钟等待,
   * 而那正是冷却存在的理由。所以停用要**保留**状态,与「换 key 才重置」一致。
   *
   * 有上限:配置里 Worker 最多 512 个,但这张表跨多次 sync 累积,
   * 而热更新可以反复改配置。超出就丢最老的 —— 丢掉只意味着那个 Worker
   * 重新启用时从零开始,不是数据损坏。
   */
  #retired = new Map<string, RetiredState>();

  constructor(config?: Config) {
    if (config !== undefined) this.sync(config);
  }

  /**
   * 用一份新配置替换 Worker 列表,**保留**同 id 的冷却状态。
   *
   * 不保留会让配置热更新变成一次"全员复活":用户在管理后台改个端口,
   * 所有正在冷却的 Worker 立刻重新就绪,于是刚被限流的账号马上又被打一遍。
   *
   * ## 但 apiKey 变了就重置
   *
   * 换 key 是用户对「这个账号不能用」的**直接回应**。此时还让它继续冷却
   * 到期,用户会看到自己刚修好的 key 依然被跳过,合理推断是"改了没生效"。
   * 这是少数几处「状态不如用户意图重要」的地方。
   *
   * 出口(proxyId)变化**不**重置:那不改变 Worker 的额度与鉴权状态,
   * 而限流与鉴权失败正是冷却的主要来源。
   *
   * ## 停用再启用同样保留 —— 状态从 `#retired` 找回
   *
   * 只看 `#workers` 是不够的:它已被 `filter(isUsable)` 过滤,停用的 Worker
   * 不在里面。第五轮审核实测:429 `Retry-After: 900` 之后停用再启用,
   * 剩余冷却从 900000ms 变成 0 —— Phase 9 的后台点两下就能抹掉上游明确
   * 要求的等待。停用不是「用户修好了这个账号」,不该获得与换 key 同等的重置。
   */
  sync(config: Config): void {
    const previous = new Map(this.#workers.map((w) => [w.id, w] as const));

    // 这一轮不再可用的,把状态存进 #retired 等它回来。
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
      // 在池里的优先;不在池里的去 #retired 找(停用过一段时间又回来)。
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

    // 回到池里的不必再留一份。
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

  readyCount(now: number): number {
    return this.#workers.filter((w) => isWorkerReady(w.cooldownUntil, now)).length;
  }

  /** 供 `/health` 与管理后台:`poolHealth()` 的入参。 */
  counts(now: number): { ready: number; total: number } {
    return { ready: this.readyCount(now), total: this.#workers.length };
  }

  /**
   * 记一次成功 —— 清零计数，并在**这次尝试确实晚于冷却**时解除冷却。
   *
   * ## 为什么要看发起时刻（第十轮审核实测）
   *
   * 「一次成功证明它现在能用」只在这次尝试**发出于冷却生效之后**才成立。
   * 而 `record()` 的调用顺序由**上游响应到达顺序**决定，不由发起顺序决定：
   *
   * ```
   * 请求A 发出 ──── 上游慢 300ms ──→ 200 成功   ← 记账在后
   * 请求B 发出 → 立刻 429 Retry-After: 900      ← 记账在前
   * ```
   *
   * 先前这里无条件 `cooldownUntil: 0`，于是请求 A 那次成功（它在冷却生效
   * **之前**就已发出，对"现在能不能用"零信息）把上游明确要求的 900 秒清成 0。
   * 触发不需要巧合：429 通常是账号级的，而多轮对话客户端天然并发。
   *
   * 这是 `markNotBlamed` 那条判据的推广。那里写的是「『不归咎于 Worker』
   * 不等于『证明它现在能用』」；同一条再推一步就是 **「一次成功」不等于
   * 「现在能用」—— 要看它是什么时候发出的**。
   *
   * `attemptStartedAt` 由调用方按 `now - latencyMs` 算出（`AttemptRecord`
   * 已有 `latencyMs`，不必新增字段）。取不到时传 `now`，那退化成原来的行为
   * —— 对「尝试发出时没有冷却」这个最常见的情形完全一致。
   *
   * 不可重试的 4xx **不要**用这个,用 `markNotBlamed()` —— 见那里的说明。
   */
  markSuccess(workerId: string, attemptStartedAt: number): void {
    this.#update(workerId, (current) => {
      /*
       * 这次尝试发出时冷却已经结束（或本来就没有冷却）→ 它对"现在能用"
       * 确实有信息，清掉冷却。否则只清计数 —— 与 `markNotBlamed` 同一处置。
       *
       * 用 `>=` 而不是 `>`：`cooldownUntil` 恰好等于发起时刻意味着冷却刚到期，
       * 那次尝试是在冷却之后发出的。
       */
      const startedAfterCooldown =
        Number.isFinite(attemptStartedAt) && attemptStartedAt >= current.cooldownUntil;
      return {
        ...(startedAfterCooldown ? { cooldownUntil: 0 } : {}),
        consecutiveFails: 0,
        lastFailure: null,
      };
    });
  }

  /**
   * 记一次**不归咎于该 Worker**的失败:清零失败计数,但**不动冷却**。
   *
   * 不变量 #4 要求 400/422 与出口配置错误不打掉健康 Worker。先前这里直接复用
   * `markSuccess`,第五轮审核实测出后果:
   *
   * ```
   * 429 Retry-After:900 之后  剩余 = 895000 ms
   * 一次出口配置错误之后      剩余 = 0 ms  ready = true
   * ```
   *
   * 上游明确说了等 900 秒,我们 5 秒后就认为它可用 —— `markFailure` 里
   * 「冷却只延长不缩短」的 `Math.max` 被从旁路整个绕过。触发不需要巧合:
   * 全员冷却时 `select` 仍会返回最早恢复的那个,所以坏请求真的会打到它。
   *
   * 根因是「记成功」这个动作**过强**:**「不归咎于 Worker」不等于「证明它现在
   * 能用」**。出口配置错误尤其 —— 那次请求根本没到上游,它对 Worker 的
   * 可用性零信息。
   *
   * 清零计数仍然要做:那是不变量 #4 原本的目的(坏请求不该把退避推到指数级)。
   */
  markNotBlamed(workerId: string): void {
    this.#update(workerId, () => ({
      consecutiveFails: 0,
      lastFailure: null,
    }));
  }

  /**
   * 记一次失败并按类别冷却。返回冷却到的时刻;`null` 表示未冷却。
   *
   * `jitter` 由调用方注入(生产用 `Math.random()`),让单测能断言确切时长。
   */
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

    /*
     * 失败计数**无论传入哪种 kind** 都要加 —— 这是本方法的局部不变量。
     *
     * ⚠️ **这里先前描述了一个 UI 上看不到的诊断场景**（第十轮审核查出）：
     * 原文说「连续失败 12 次却从未冷却」是「客户端一直在发坏请求」的证据。
     * 但 `Scheduler.record()` 的分支是
     * `if (!blameWorker || !shouldCooldown(failure)) → markNotBlamed`（**清零**），
     * 而 `shouldCooldown` 恰好就是 `kind !== "bad_request" && kind !== "unknown"`
     * —— 也就是**所有不冷却的类别都走不到这里**。实测 12 次 `bad_request`
     * 之后连续失败数仍是 0（两种 `blameWorker` 都试过）。
     *
     * 所以这段计数对 `bad_request` 是**防御性冗余**：不归咎的类别由 `record`
     * 拦在前面。`WorkersPage` 的「连续失败」一列仍然有用 —— 它显示的是
     * 真实故障（限流、传输失败、上游 5xx）的连续次数，那些都会走到这里。
     */
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
      /*
       * 取较大值,不直接覆盖。
       *
       * 并发请求会让两次失败乱序到达:先算出的长冷却(如 429 的 15 分钟)
       * 若被后算出的短冷却(如一次传输失败的 2 秒)覆盖,那个刚限流我们的
       * 上游会在 2 秒后再被打一遍 —— 而 `Retry-After` 明确说了要等 15 分钟。
       * 冷却只该延长,不该被另一次失败缩短。
       */
      cooldownUntil: until === null ? current.cooldownUntil : Math.max(current.cooldownUntil, until),
      consecutiveFails,
      lastFailure: input.kind,
    }));

    return this.get(input.workerId)?.cooldownUntil ?? null;
  }

  /** 供诊断导出。不含 apiKey —— 它是凭证。 */
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
