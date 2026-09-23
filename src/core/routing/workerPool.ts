import type { Config, Worker, WorkerKind } from "../../shared/schema.ts";
import type { FailureKind } from "../failures.ts";
import { cooldownUntil } from "./cooldown.ts";

/**
 * Worker 集合与就绪判定 —— 调度状态机里**唯一**持有可变状态的部分。
 *
 * 其余三块(`cooldown` / `affinity` 的判定 / `select`)都是纯函数或纯数据结构,
 * 状态集中在这里一处,是为了让「为什么这次选了它」可以由一次 `snapshot()`
 * 完整回答。旧项目把状态与选择混在一个 432 行的 class 里,那个问题答不了。
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

/**
 * Worker 是否可用于转发。
 *
 * 必须有上游 key。schema 里 `kind: "anonymous"` 允许空 apiKey,那是为
 * 「免鉴权免费额度」留的形态 —— 而上游已于 2026-09-16 前后关闭该通道
 * (免 key 请求免费模型返回 403 FreeTierError)。没有 key 的 Worker 发出去
 * 必定失败,放进候选链只会白占一次尝试,并把真实原因(没配 key)埋进重试日志。
 *
 * 按「有没有 key」判断而不按 kind:kind 是用户的声明,key 是能不能用的事实,
 * 后者才是调度该依据的。
 */
export function isUsable(worker: Worker): boolean {
  if (!worker.enabled) return false;
  return worker.apiKey.trim() !== "";
}

export class WorkerPool {
  /** 按配置顺序。顺序本身有意义 —— 见 `select.ts` 的策略排序。 */
  #workers: WorkerRuntime[] = [];

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
   */
  sync(config: Config): void {
    const previous = new Map(this.#workers.map((w) => [w.id, w] as const));

    this.#workers = config.workers.filter(isUsable).map((w) => {
      const prior = previous.get(w.id);
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
    return worker !== null && worker.cooldownUntil <= now;
  }

  readyCount(now: number): number {
    return this.#workers.filter((w) => w.cooldownUntil <= now).length;
  }

  /** 供 `/health` 与管理后台:`poolHealth()` 的入参。 */
  counts(now: number): { ready: number; total: number } {
    return { ready: this.readyCount(now), total: this.#workers.length };
  }

  /**
   * 记一次成功。
   *
   * 也用于**不可重试的 4xx**(不变量 #4):400/422 是请求本身的问题,
   * 不是 Worker 的问题。此时必须清掉失败计数,否则一个客户端的坏请求
   * 反复发几次,就能把连续失败数推高,下一次真实故障的退避从错误的指数级
   * 起跳 —— 一次拼错的请求体让整个池的恢复速度变慢。
   */
  markSuccess(workerId: string): void {
    this.#update(workerId, () => ({
      cooldownUntil: 0,
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
     * 失败计数**无论是否冷却**都要加。
     *
     * `bad_request` 不冷却,但它仍是一次失败 —— 诊断里"连续失败 12 次却
     * 从未冷却"正是"客户端一直在发坏请求"这个结论的证据,而把计数也跳过
     * 就把这条线索抹掉了。
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
      ready: w.cooldownUntil <= now,
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
