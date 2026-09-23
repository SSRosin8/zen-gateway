import type { Config } from "../../shared/schema.ts";
import type { FailureKind } from "../failures.ts";
import type { AttemptRecord, AttemptTarget } from "../upstream/retry.ts";
import { AffinityMap, containsStaleReasoning } from "./affinity.ts";
import { WorkerPool } from "./workerPool.ts";
import { select, type Selection } from "./select.ts";

/**
 * 调度器 —— 把 `workerPool` / `cooldown` / `affinity` / `select` 装成一个对象,
 * 并**独占**进程内的调度状态。
 *
 * ## 为什么要这一层
 *
 * 四块各自是纯函数或纯数据结构,但它们之间有次序约束(选之前要 sync、
 * 结算要在流结束之后、亲和绑定与冷却必须看同一个 `now`)。这些约束若散在
 * 路由里,Phase 6 新增协议面时会被复制一遍,而复制的两份必然分叉。
 *
 * 路由层因此只看得到三个动作:`plan` → `record` → `settleStream`。
 *
 * ## 进程内唯一
 *
 * 与 `EgressService` 同理:两个调度器意味着两份冷却状态,于是"这个 Worker
 * 在冷却"取决于请求碰巧走到哪一份 —— 而冷却是为了别再打那个上游。
 */

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
  #affinity = new AffinityMap();
  /**
   * 上一次 sync 用的配置对象**引用**。
   *
   * 用引用比较而非深比较:`configOf()` 在没有热更新时返回同一个对象,
   * 而深比较一份含 512 个 Worker 的配置要跑在每个请求上。热更新必然产生
   * 新对象(schema.parse 的结果),所以引用变化正是"配置换了"的准确信号。
   */
  #syncedFrom: Config | null = null;

  /** 注入以便测试断言确切的冷却时长。 */
  readonly #jitter: () => number;

  constructor(opts?: { jitter?: () => number }) {
    this.#jitter = opts?.jitter ?? Math.random;
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
   * 记一次尝试的结局。由 `retry.ts` 的 `onAttempt` 逐次调用。
   *
   * 三条分支对应不变量 #4 的完整含义:
   *
   * - **成功** → 清零(冷却也解除:它证明了这个 Worker 现在能用)
   * - **失败但不归咎 Worker**(`bad_request`、出口配置错误)→ 也记成功。
   *   否则一个客户端的坏请求会把所有健康 Worker 逐个打进冷却。
   * - **失败且归咎 Worker** → 按类别冷却
   */
  record(record: AttemptRecord, config: Config, now: number): void {
    this.#ensureSynced(config);

    if (record.failure === null || !record.blameWorker) {
      this.#pool.markSuccess(record.workerId);
      return;
    }

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
   * 重试链 settled 之后,把会话改绑到**实际**承接的 Worker。
   *
   * ## 为什么 plan 时的绑定不够
   *
   * `plan` 绑的是候选链**首位**,而重试链可能往后走:一条
   * 「w1 拿到 429 → w2 成功」的链里,签发推理块的是 **w2**。若绑定仍停在 w1,
   * 等 w1 冷却结束,下一轮就回到它 —— 而客户端回放的是 w2 签发的推理块,
   * 上游必拒。症状是「对话隔一会儿就报一次错」,而且只在限流之后出现。
   *
   * 集成测试查出来的:单测结构上测不到它,因为单测模拟的是「冷却发生在
   * plan **之前**」,而这个缺陷只在「冷却发生在请求**过程中**」时出现。
   *
   * ## 为什么不放在 settleStream 里
   *
   * 会话身份在链 settled 的那一刻就已确定,不需要等流读完。而 `settleStream`
   * 挂在流末尾 —— 它只在**客户端真的读完响应**时触发。把会话改绑放在那里,
   * 一次客户端提前断开就会让绑定停在错误的 Worker 上。
   *
   * 只在成功时改绑:全链失败时「实际承接者」是最后一个失败的那个,绑上去
   * 没有意义 —— 而它已进入冷却,下一轮自然会重挑。
   */
  rebind(sessionHash: string | null, workerId: string, now: number): void {
    if (sessionHash === null) return;
    if (!this.#pool.has(workerId)) return;
    this.#affinity.bindSession(sessionHash, workerId, now);
  }

  /**
   * 不变量 #3:流结束后的亲和结算。
   *
   * 三种结局,处置完全不同:
   *
   * | 结局 | 动作 | 为什么 |
   * |---|---|---|
   * | 检出失效推理 | 解绑会话 + 忘掉指纹 | 留着会让下一轮回到同一个必败 Worker |
   * | 2xx 且完整读完 | 学习指纹 → 该 Worker | 成功服务证明它接受这批推理块 |
   * | 不完整(断流/客户端取消) | **什么都不做** | 上游可能在未读到的部分拒绝了 |
   *
   * 第三行是关键:`complete === false` 时既不学也不忘。学了可能把一个其实
   * 会拒的 Worker 记成正确答案;忘了则会白丢一个可能正确的绑定
   * (客户端按 ESC 中断生成属于这一类,而那与推理是否有效毫无关系)。
   *
   * 注意会话绑定**不在**这三行里 —— 它由 `rebind` 在链 settled 时处理,
   * 见那里的说明。
   */
  settleStream(input: {
    /**
     * 承接本次请求的 Worker;**失败路径传 null**。
     *
     * 可空不是图方便:`workerId` 只被"学习指纹"这一个分支用到,而学习只发生在
     * 2xx。失败路径(`result.ok === false` ⇒ status ≥ 400)永远走不到那里,
     * 所以在那里编一个 workerId 是**死信息** —— 它会让读代码的人以为
     * 失败路径也在按 Worker 记账。
     *
     * 先前这里传的是 `result.attempts.at(-1)?.workerId ?? ""`,变异测试
     * 把它换成 `""` 后全部测试依然绿 —— 那正是"这个值根本没被用"的证据,
     * 而不是测试的漏洞。
     */
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
    // 走到这里 status 必为 2xx,而 2xx 只出现在成功路径 —— 那里一定有 workerId。
    if (input.workerId === null) return;

    this.#affinity.learnBlobs(input.blobHashes, input.workerId, input.now);
  }

  /**
   * 非流式响应的结算。
   *
   * 与 `settleStream` 分开只为让调用点读起来清楚 —— 非流式下响应体已经
   * 完整送达,不存在"不完整"这一态。内部委托同一套逻辑,不复制判断。
   */
  settleBuffered(input: {
    readonly workerId: string;
    readonly sessionHash: string | null;
    readonly blobHashes: readonly string[];
    readonly status: number;
    readonly bodyText: string;
    readonly now: number;
  }): void {
    this.settleStream({
      workerId: input.workerId,
      sessionHash: input.sessionHash,
      blobHashes: input.blobHashes,
      status: input.status,
      staleHit: containsStaleReasoning(input.bodyText),
      complete: true,
      now: input.now,
    });
  }

  /** 供 `/health` 与管理后台。 */
  counts(config: Config, now: number): { ready: number; total: number } {
    this.#ensureSynced(config);
    return this.#pool.counts(now);
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

  /** 丢掉过期与指向已删除 Worker 的亲和条目。由管理面或定期任务调用。 */
  prune(config: Config, now: number): void {
    this.#ensureSynced(config);
    this.#affinity.prune(now, config.routing.affinityTtlMs, (id) => this.#pool.has(id));
  }

  #ensureSynced(config: Config): void {
    if (this.#syncedFrom === config) return;
    this.#pool.sync(config);
    this.#syncedFrom = config;
  }
}

/** 候选链为空时的诊断信息来源 —— 转出以便路由只 import 一个模块。 */
export type { AttemptTarget, FailureKind };
