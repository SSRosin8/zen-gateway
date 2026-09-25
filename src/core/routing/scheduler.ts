import type { Config } from "../../shared/schema.ts";
import { RoutingConfigSchema } from "../../shared/schema.ts";
import { shouldCooldown, type FailureKind } from "../failures.ts";
import type { AttemptRecord, AttemptTarget } from "../upstream/retry.ts";
import { AffinityMap, containsStaleReasoning } from "./affinity.ts";
import type { AffinitySink, RestoredBinding } from "./affinity.ts";
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

/**
 * 亲和 TTL 的兜底值,从 **schema 的默认值**推导而不是另写一个字面量。
 *
 * 两份默认值必然分叉(纪律 #4),而分叉方向是漏:改了 schema 却没改这里,
 * 容量淘汰会按一个陈旧的 TTL 判断"什么算过期"。
 *
 * 它只在 `plan()`/`record()` 从未被调用过(即还没 sync 过任何配置)时生效 ——
 * 实际流程里 `plan` 总在 `rebind`/`settleStream` 之前,所以这是纯兜底。
 */
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
  /**
   * 上一次 sync 用的配置对象**引用**。
   *
   * 用引用比较而非深比较:`configOf()` 在没有热更新时返回同一个对象,
   * 而深比较一份含 512 个 Worker 的配置要跑在每个请求上。热更新必然产生
   * 新对象(schema.parse 的结果),所以引用变化正是"配置换了"的准确信号。
   */
  #syncedFrom: Config | null = null;

  /**
   * 最近一次 sync 时的亲和 TTL。
   *
   * 容量淘汰需要知道"什么算过期"(见 `AffinityMap.evict`),而
   * `rebind`/`settleStream` 的签名里没有 config —— 它们在链结束与流结束时被
   * 调用,那时把整份配置再传一遍只是噪音。缓存这一个数值即可。
   *
   * 初值从 schema 默认值推导,不写字面量:两份默认值必然分叉(纪律 #4)。
   */
  #ttlMs: number = DEFAULT_AFFINITY_TTL_MS;

  /** 注入以便测试断言确切的冷却时长。 */
  readonly #jitter: () => number;

  /**
   * `affinitySink` 传入则亲和绑定镜像落盘（Phase 7）。
   *
   * 不传则纯内存 —— 全部既有单测走这条路，而它们测的是调度逻辑，
   * 不该为此各自建一个临时数据库。
   */
  constructor(opts?: { jitter?: () => number; affinitySink?: AffinitySink }) {
    this.#jitter = opts?.jitter ?? Math.random;
    this.#affinity = new AffinityMap(opts?.affinitySink);
  }

  /**
   * 启动时把持久化的亲和绑定装回内存。
   *
   * 必须按 `at` 升序传入 —— 见 `AffinityMap.restore`。
   */
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
   * 记一次尝试的结局。由 `retry.ts` 的 `onAttempt` 逐次调用。
   *
   * `now` 必须是**这次尝试结束的时刻**,不是请求开始的时刻 —— 见
   * `relay.ts` 里 `nowOf()` 的说明。一次尝试可以耗 60-300 秒(headers/body
   * 超时),用开始时刻会把冷却算进过去。
   *
   * 三条分支,而分支条件**从 `shouldCooldown` 推导**而不是另写一份:
   *
   * - **成功** → `markSuccess`(清零 + 解除冷却)。上游用行为证明了它现在能用。
   * - **不归咎 Worker,或该类别本就不冷却** → `markNotBlamed`(清零,**保留冷却**)
   * - 其余 → `markFailure`,按类别冷却
   *
   * ## 第二条为什么要带上 `!shouldCooldown`
   *
   * 这是第五轮审核查出的第四处「两份并行判断」(纪律 #4)。先前分支只看
   * `blameWorker`,而 `shouldCooldown()` 把 `bad_request` 与 `unknown`
   * **同等对待**(都不冷却)—— 两份判断不是同一个真相。后果实测:
   *
   * ```
   * 5x bad_request 后一次 transport 冷却 = 2000 ms
   * 5x unknown     后一次 transport 冷却 = 64000 ms  (上限 120000)
   * ```
   *
   * `unknown` 的 `blameWorker` 为 true(`retry.ts` 只对出口配置错误置 false),
   * 于是它走 `markFailure`:计数 +1 而冷却为 null,计数无界膨胀,把后续**真实**
   * 故障的退避直接推到上限。这正是 `markSuccess` 注释声称已防住的问题,
   * 只是入口从 `bad_request` 换成了 `unknown`。
   *
   * 代价是一个取舍:`transport, unknown, transport, unknown…` 交替时退避
   * 不会升级。接受它 —— `unknown` 只来自非 `Error` 抛出物(`classifyError`),
   * 极少见;而「我们没看懂的失败」本就不该拿 Worker 的可用性去赌。
   */
  record(record: AttemptRecord, config: Config, now: number): void {
    this.#ensureSynced(config);

    if (record.failure === null) {
      /*
       * 发起时刻 = 记账时刻 − 这次尝试的耗时。
       *
       * `markSuccess` 需要它来判断「这次成功对『现在能用』是否有信息」——
       * 一次在冷却生效**之前**就已发出的成功（并发下很常见）不该清掉冷却。
       * 理由写在 `markSuccess` 上。
       *
       * `latencyMs` 非有限时退回 `now`，那退化成原来的无条件清除 ——
       * 对「发出时没有冷却」这个最常见的情形结果一致。
       */
      const startedAt = Number.isFinite(record.latencyMs) ? now - record.latencyMs : now;
      this.#pool.markSuccess(record.workerId, startedAt);
      return;
    }

    if (!record.blameWorker || !shouldCooldown(record.failure)) {
      this.#pool.markNotBlamed(record.workerId);
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
    this.#affinity.bindSession(sessionHash, workerId, now, this.#ttlMs);
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

    this.#affinity.learnBlobs(input.blobHashes, input.workerId, input.now, this.#ttlMs);
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

  /**
   * Worker 就绪数与总数。
   *
   * ⚠️ **本方法仍没有生产调用点，而那是对的。**
   *
   * Phase 9 的 `/api/overview` 需要的是**与 Worker 列表同源**的计数
   * （`admin/project.ts` 的 `poolCounts` 从 `workerViews` 推导）——
   * 若这里再问一次，同一个响应里的 `pool.ready` 与 `workers[].ready`
   * 就来自两次独立查询，中间状态可能变过，而用户会把它们当成一句话读
   * （「3 个 Worker，2 个就绪」后面跟着一张三行的表）。
   *
   * 先前这里写的是「供 `/health` 与管理后台」—— 而 `/health` 的 handler
   * 完全不调 scheduler（第七轮审核查出那是个**假的调用点声明**）。
   * 保留 + 标注，与 `snapshot()`/`status()` 同格式。
   */
  counts(config: Config, now: number): { ready: number; total: number } {
    this.#ensureSynced(config);
    return this.#pool.counts(now);
  }

  /**
   * Worker 的运行期状态 —— 管理 API 的数据来源（Phase 9）。
   *
   * ## 为什么不直接用 `snapshot()`
   *
   * `snapshot()` 返回的是 `WorkerPool` 的内部形状（含 `kind`/`proxyId`，
   * 那些**配置里已经有了**），而管理面需要的恰好是配置里**没有**的那一半：
   * 冷却剩余、连续失败、就绪与否。让投影层去 `snapshot()` 里挑字段会形成
   * 一处隐式耦合 —— 那个方法的形状为诊断导出而定，改它会悄悄改掉 API 契约。
   *
   * 这个方法只承诺管理 API 需要的那几个字段，两者各自演进。
   * `snapshot()` 因此**仍然没有生产调用点**，如实标注着。
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

  /** 丢掉过期与指向已删除 Worker 的亲和条目。由管理面或定期任务调用。 */
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

/** 候选链为空时的诊断信息来源 —— 转出以便路由只 import 一个模块。 */
export type { AttemptTarget, FailureKind };
