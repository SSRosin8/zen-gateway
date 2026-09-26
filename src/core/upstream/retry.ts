import type { Response as UndiciResponse } from "undici";
import type { FailureKind } from "../failures.ts";
import { classifyError, classifyStatus, isRetryable } from "../failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { elapsedMs } from "../../shared/elapsed.ts";
import { EgressSetupError, fetchUpstream, type UpstreamDeps, type UpstreamRequest } from "./fetch.ts";

/**
 * 重试链。
 *
 * 不变量 #1:只依据 status + headers 判重试,响应体始终未消费,由 `pipe.ts` 在链结束后独占写出。
 * 不变量 #2:非最后一次尝试必须取消 body(否则连接悬挂);最后一次保留 body,让客户端看到上游真实错误。
 * 不变量 #4:不可重试的 4xx 不归咎 Worker,否则一个坏请求会把所有健康 Worker 打进冷却;
 * 冷却由调度层执行,这里经 `onAttempt` 如实报出 `blameWorker`。
 */

export type AttemptTarget = {
  readonly workerId: string;
  readonly apiKey: string;
  readonly proxyId: string | null;
};

/** 单次尝试的结局,供调用方记账(冷却、亲和与统计)。 */
export type AttemptRecord = {
  readonly workerId: string;
  /** null 表示这次尝试成功。 */
  readonly failure: FailureKind | null;
  /** 是否应归咎于该 Worker;`bad_request` 与出口配置错误都不归咎(不变量 #4)。 */
  readonly blameWorker: boolean;
  readonly retryAfter: string | null;
  /** 上游状态码。建连前就失败时为 null,不写 0/-1,以免与上游返回码在统计里混淆。 */
  readonly status: number | null;
  /** 从发起到拿到响应头(或抛错)的耗时,不含读体;非负整数(见 `elapsedMs()`)。 */
  readonly latencyMs: number;
};


export type RetryResult =
  | {
      readonly ok: true;
      /** 响应体未被消费,交由 pipe.ts 写出。 */
      readonly response: UndiciResponse;
      readonly workerId: string;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly ok: false;
      /** 最后一次尝试的上游响应(若拿到了),body 未消费,原样转发给客户端。 */
      readonly response: UndiciResponse | null;
      readonly kind: FailureKind;
      /**
       * 失败是本机出口配置问题。分类仍是 `bad_request`(冷却与重试处置相同),
       * 单独标出只为给客户端正确措辞,而不是让用户去查请求体。
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
  readonly signal?: AbortSignal;
  readonly deps: UpstreamDeps;
  /**
   * 请求的模型是否经过在架目录核验。为 false 时上游 401 不归咎 Worker:免 key 请求未知模型
   * 也返回 401,无法与坏 key 区分。省略视为已核验。
   */
  readonly modelVerified?: boolean;
  /** 每次尝试结束后回调,供记账。 */
  readonly onAttempt?: (record: AttemptRecord) => void;
  /**
   * 取当前时刻,默认 `Date.now`。刻意不用 `performance.now()`:耗时与 `upstream_attempts.at`
   * 的墙钟时刻记在同一行,混用时间源会在时钟调整后互相矛盾。
   */
  readonly clock?: () => number;
};

/**
 * 依次尝试候选 Worker,返回响应体未被消费的结果。
 * 不做退避等待(属于调度状态机),只负责换下一个的顺序与 body 取消的非对称。
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
   * 单独记住最后一次非出口配置的失败并优先报告:否则「w1、w2 传输失败 → w3 代理已停用」
   * 会把真实的上游不可达报成客户端 400。
   */
  let lastRealFailure: typeof lastFailure | null = null;

  for (let i = 0; i < limit; i += 1) {
    input.signal?.throwIfAborted();
    const target = input.targets[i]!;
    const isLast = i === limit - 1;

    const req: UpstreamRequest = {
      url: input.url,
      method: input.method,
      headers: input.buildHeaders(target),
      body: input.body,
      proxyId: target.proxyId,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    };

    const startedAt = clock();

    let response: UndiciResponse;
    try {
      response = await fetchUpstream(req, input.deps);
    } catch (err) {
      if (input.signal?.aborted) throw err;
      // 出口配置错误换任何 Worker 都不会好,也不归咎 Worker,否则健康 Worker 被冷却而真实原因被掩盖。
      const isSetup = err instanceof EgressSetupError;
      const kind: FailureKind = isSetup ? "bad_request" : classifyError(err);
      const record: AttemptRecord = {
        workerId: target.workerId,
        failure: kind,
        blameWorker: !isSetup,
        retryAfter: null,
        // 建连之前就失败,没有状态码。
        status: null,
        latencyMs: elapsedMs(clock, startedAt),
      };
      attempts.push(record);
      input.onAttempt?.(record);

      lastFailure = {
        kind,
        reason: safeErrorMessage(err),
        response: null,
        egressSetup: isSetup,
      };
      if (!isSetup) lastRealFailure = lastFailure;
      // 配置错误换 Worker 无意义,但换代理可能有意义 —— 仍继续走候选链。
      continue;
    }

    // 客户端可能在响应头到达的同一时刻断开:不交给透传层,也不再重试。
    if (input.signal?.aborted) {
      await response.body?.cancel().catch(() => {});
      input.signal.throwIfAborted();
    }

    const failure = classifyStatus({ status: response.status, headers: response.headers });

    if (failure === null) {
      const record: AttemptRecord = {
        workerId: target.workerId,
        failure: null,
        blameWorker: false,
        retryAfter: null,
        status: response.status,
        latencyMs: elapsedMs(clock, startedAt),
      };
      attempts.push(record);
      input.onAttempt?.(record);
      return { ok: true, response, workerId: target.workerId, attempts };
    }

    // 不变量 #4:`bad_request` 换 Worker 也一样失败,既不重试也不冷却。
    const unverifiedModel401 = response.status === 401 && input.modelVerified === false;
    const blameWorker = failure !== "bad_request" && !unverifiedModel401;
    const record: AttemptRecord = {
      workerId: target.workerId,
      failure,
      blameWorker,
      retryAfter: response.headers.get("retry-after"),
      status: response.status,
      latencyMs: elapsedMs(clock, startedAt),
    };
    attempts.push(record);
    input.onAttempt?.(record);

    const canRetry = isRetryable(failure) && !isLast;

    if (!canRetry) {
      // 不变量 #2:最后一次尝试保留 body。
      return {
        ok: false,
        response,
        kind: failure,
        egressSetup: false,
        reason: `上游返回 ${response.status}`,
        attempts,
      };
    }

    // 不变量 #2:非最后一次尝试取消 body;cancel 失败吞掉,不盖住真实失败。
    await response.body?.cancel().catch(() => {});
    lastFailure = {
      kind: failure,
      reason: `上游返回 ${response.status}`,
      response: null,
      egressSetup: false,
    };
    lastRealFailure = lastFailure;
  }

  // 优先报真实失败;全链都是出口配置问题时才报后者。
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
