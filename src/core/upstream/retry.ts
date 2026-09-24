import type { Response as UndiciResponse } from "undici";
import type { FailureKind } from "../failures.ts";
import { classifyError, classifyStatus, isRetryable } from "../failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { EgressSetupError, fetchUpstream, type UpstreamDeps, type UpstreamRequest } from "./fetch.ts";

/**
 * 重试链。
 *
 * ## 不变量 #1:这一层绝不读响应体,也绝不写客户端字节
 *
 * 重试判定只依据 status + headers(`classifyStatus` 的入参结构上就不含 body),
 * 返回的结果里**响应体始终未被消费**,由 `pipe.ts` 在重试链彻底结束之后
 * 独占写出。
 *
 * 一旦这条被破坏 —— 无论是「读 body 才能判断要不要重试」还是「边转发边重试」
 * —— 症状都是同一个:已经给客户端发了 200 和一部分 SSE,然后又去重试,
 * 客户端收到两段拼接的响应。这种响应在客户端侧表现为 JSON 解析失败或
 * 对话内容莫名重复,极难归因到网关。
 *
 * ## 不变量 #2:body 取消的非对称性
 *
 * - **非最后一次**尝试:必须 `await response.body?.cancel()`。不取消会让连接
 *   悬挂在池里直到超时,高频下耗尽连接。
 * - **最后一次**尝试:必须**保留** body。客户端应当看到上游真实的错误负载
 *   (例如 429 的 `retry-after` 说明、400 的字段级报错),而不是网关编的话。
 *
 * ## 不变量 #4:不可重试的 4xx 要记成功
 *
 * 400/422 这类是**请求本身**的问题,不是 Worker 的问题。此时必须把该 Worker
 * 记为成功,否则一个客户端的坏请求会把所有健康 Worker 逐个打进冷却 ——
 * 一次拼错的请求体就能让整个网关瘫痪。冷却动作在 Phase 5 接入,
 * 这里通过 `onAttempt` 把「这次失败该不该归咎于 Worker」如实报出去。
 */

export type AttemptTarget = {
  readonly workerId: string;
  readonly apiKey: string;
  readonly proxyId: string | null;
};

/** 单次尝试的结局,供调用方记账(Phase 5 接冷却与亲和,Phase 7 接统计)。 */
export type AttemptRecord = {
  readonly workerId: string;
  /** null 表示这次尝试成功。 */
  readonly failure: FailureKind | null;
  /**
   * 是否应归咎于该 Worker。
   *
   * `bad_request` 与出口配置错误都**不**归咎 —— 见不变量 #4。
   */
  readonly blameWorker: boolean;
  readonly retryAfter: string | null;
  /**
   * 上游状态码。**建连之前就失败时为 null**（传输错误、出口配置错误）——
   * 那种情况下根本没有状态码，而写 0 或 -1 会让「网关自己失败」和
   * 「上游返回了某个码」在统计里混成一类（Phase 7 的 `upstream_attempts.status`
   * 允许 NULL 正是为此）。
   */
  readonly status: number | null;
  /** 这次尝试耗时。从发起到拿到响应头（或抛错）为止，不含读体。 */
  readonly latencyMs: number;
};

export type RetryResult =
  | {
      readonly ok: true;
      /** 响应体**未被消费**,交由 pipe.ts 写出。 */
      readonly response: UndiciResponse;
      readonly workerId: string;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly ok: false;
      /**
       * 最后一次尝试的上游响应(若拿到了)。
       * body 未被消费 —— 要原样转发给客户端,让它看到上游真实的错误。
       */
      readonly response: UndiciResponse | null;
      readonly kind: FailureKind;
      /**
       * 这次失败是**本机出口配置**问题(代理不存在/已停用/只能桥接但 Clash 关着/
       * 内核缺 selector 分组),而不是上游或请求本身的问题。
       *
       * 单独一个字段而不是新增一个 `FailureKind` 变体:`FailureKind` 驱动冷却与
       * 重试判定,而出口配置失败在那两件事上的处置与 `bad_request` 完全相同
       * (不冷却、不归咎 Worker)。差别只在**给客户端的措辞**:
       * 400「请求无效」会让用户去检查请求体,而真实原因是他的 Clash 没开。
       * 所以分类保持 `bad_request`,只额外标出真实归因。
       */
      readonly egressSetup: boolean;
      /** 已脱敏的原因,用于日志与(无上游响应时的)网关自造错误体。 */
      readonly reason: string;
      readonly attempts: readonly AttemptRecord[];
    };

export type RetryInput = {
  /** 按优先级排好的候选 Worker。链最长走 `maxAttempts` 个。 */
  readonly targets: readonly AttemptTarget[];
  readonly maxAttempts: number;
  /** 除 Authorization 外的上游头;每次尝试按 Worker 的 key 重算鉴权头。 */
  readonly buildHeaders: (target: AttemptTarget) => Record<string, string>;
  readonly url: string;
  readonly method: string;
  readonly body: Uint8Array | null;
  readonly deps: UpstreamDeps;
  /** 每次尝试结束后回调,供记账。 */
  readonly onAttempt?: (record: AttemptRecord) => void;
  /**
   * 取当前时刻,用于算每次尝试的耗时。注入以便测试断言确切的毫秒数。
   *
   * 默认 `Date.now`。**刻意不用 `performance.now()`**:耗时要与
   * `upstream_attempts.at` 的墙钟时刻记在同一行，两个时间源混用会让
   * 「这次尝试何时开始、耗了多久」在时钟调整后互相矛盾。
   */
  readonly clock?: () => number;
};

/**
 * 依次尝试候选 Worker,返回**响应体未被消费**的结果。
 *
 * 不做退避等待:那属于调度状态机(Phase 5)。这里只负责「换下一个」的顺序
 * 与「body 该不该取消」的非对称,这两件事是不变量,必须在本层就正确。
 */
export async function runRetryChain(input: RetryInput): Promise<RetryResult> {
  const attempts: AttemptRecord[] = [];
  const clock = input.clock ?? Date.now;
  const limit = Math.max(1, Math.min(input.maxAttempts, input.targets.length));

  if (input.targets.length === 0) {
    return {
      ok: false,
      response: null,
      kind: "unknown",
      egressSetup: false,
      reason: "没有可用的 Worker",
      attempts,
    };
  }

  let lastFailure: {
    kind: FailureKind;
    reason: string;
    response: UndiciResponse | null;
    egressSetup: boolean;
  } = {
    kind: "unknown",
    reason: "未执行任何尝试",
    response: null,
    egressSetup: false,
  };

  /*
   * 单独记住**最后一次非出口配置**的失败。
   *
   * 出口配置失败只说明"这一个 Worker 的代理配坏了",它对前面那些因真实网络
   * 原因失败的尝试什么都没解释。若只用 `lastFailure`,一条
   * 「w1 传输失败 → w2 传输失败 → w3 代理已停用」的链会把最终分类变成
   * `bad_request`,于是**一次真实的上游不可达被报成客户端 400**
   * (「你的请求无效」),用户会去检查请求体而真实原因在网络。
   *
   * 所以结尾优先报这个;两者都没有时才报配置错误。
   */
  let lastRealFailure: typeof lastFailure | null = null;

  for (let i = 0; i < limit; i += 1) {
    const target = input.targets[i]!;
    const isLast = i === limit - 1;

    const req: UpstreamRequest = {
      url: input.url,
      method: input.method,
      headers: input.buildHeaders(target),
      body: input.body,
      proxyId: target.proxyId,
    };

    const startedAt = clock();

    let response: UndiciResponse;
    try {
      response = await fetchUpstream(req, input.deps);
    } catch (err) {
      /*
       * 出口**配置**错误与网络失败要分开。
       *
       * 配置错误(代理不存在、只能桥接但 Clash 关着)换任何 Worker 都不会好,
       * 而且不该归咎于 Worker —— 把它记成 Worker 故障会让健康 Worker 被冷却,
       * 真正的原因(配置)反而被掩盖。
       */
      const isSetup = err instanceof EgressSetupError;
      const kind: FailureKind = isSetup ? "bad_request" : classifyError(err);
      const record: AttemptRecord = {
        workerId: target.workerId,
        failure: kind,
        blameWorker: !isSetup,
        retryAfter: null,
        // 建连之前就失败 —— 没有状态码。见 AttemptRecord.status 的说明。
        status: null,
        latencyMs: clock() - startedAt,
      };
      attempts.push(record);
      input.onAttempt?.(record);

      lastFailure = {
        kind,
        reason: safeErrorMessage(err),
        response: null,
        egressSetup: isSetup,
      };
      // 只有真实失败才更新 lastRealFailure —— 见它的声明处说明。
      if (!isSetup) lastRealFailure = lastFailure;
      // 配置错误换 Worker 无意义,但换代理可能有意义 —— 仍继续走候选链。
      continue;
    }

    const failure = classifyStatus({ status: response.status, headers: response.headers });

    if (failure === null) {
      const record: AttemptRecord = {
        workerId: target.workerId,
        failure: null,
        blameWorker: false,
        retryAfter: null,
        status: response.status,
        latencyMs: clock() - startedAt,
      };
      attempts.push(record);
      input.onAttempt?.(record);
      // 成功:body 未被消费,交给 pipe.ts。
      return { ok: true, response, workerId: target.workerId, attempts };
    }

    /*
     * 不变量 #4:请求本身的问题不归咎于 Worker。
     * `bad_request` 换 Worker 也一样失败,所以既不重试也不冷却。
     */
    const blameWorker = failure !== "bad_request";
    const record: AttemptRecord = {
      workerId: target.workerId,
      failure,
      blameWorker,
      retryAfter: response.headers.get("retry-after"),
      status: response.status,
      latencyMs: clock() - startedAt,
    };
    attempts.push(record);
    input.onAttempt?.(record);

    const canRetry = isRetryable(failure) && !isLast;

    if (!canRetry) {
      /*
       * 不变量 #2:最后一次尝试**保留** body。
       * 客户端要看到上游真实的错误负载,而不是网关的转述。
       */
      return {
        ok: false,
        response,
        kind: failure,
        egressSetup: false,
        reason: `上游返回 ${response.status}`,
        attempts,
      };
    }

    /*
     * 不变量 #2:非最后一次尝试必须取消 body,否则连接悬挂。
     * cancel 失败要吞掉 —— 它不该盖住我们正在处理的那个真实失败。
     */
    await response.body?.cancel().catch(() => {});
    lastFailure = {
      kind: failure,
      reason: `上游返回 ${response.status}`,
      response: null,
      egressSetup: false,
    };
    // 拿到过上游响应,这是真实失败。
    lastRealFailure = lastFailure;
  }

  // 优先报真实失败;全链都是出口配置问题时才报后者。见 lastRealFailure 的说明。
  const final = lastRealFailure ?? lastFailure;
  return {
    ok: false,
    response: final.response,
    kind: final.kind,
    egressSetup: final.egressSetup,
    reason: final.reason,
    attempts,
  };
}
