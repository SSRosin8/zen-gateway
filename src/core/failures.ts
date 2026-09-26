/**
 * 失败分类。必须是纯函数，只看状态码与响应头、绝不看响应体（不变量 #1）：
 * 读了 body 就无法再转发，流式下还会让客户端收到拼接的两段响应。
 */

/** 全部失败类别；类型由此数组推导，保证穷举测试与类型不分叉。 */
export const FAILURE_KINDS = [
  /** 限流。尊重 Retry-After,长冷却。 */
  "rate_limit",
  /** 鉴权失败。短退避：配错的 key 应反复暴露，而非安静消失 15 分钟。 */
  "auth",
  /**
   * 403。短冷却且换 Worker 重试：上游既用它表示免费闸门（`FreeTierError`），
   * 也表示地区限制；不读 body 无法区分，后者换出口可能成功。
   */
  "forbidden",
  /** 上游 5xx。可重试。 */
  "upstream_error",
  /** 连接层失败(DNS/TCP/TLS/代理拒绝)。指数退避 + 抖动。 */
  "transport",
  /** 超时。 */
  "timeout",
  /** 请求本身的问题(400/422 等)。不是 Worker 的错，不该冷却。 */
  "bad_request",
  /** 分类不明。保守处理:不重试、不冷却。 */
  "unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** 分类所需的最小信息 —— 故意不含 body,见文件头说明。 */
export type ResponseFacts = {
  status: number;
  headers: { get(name: string): string | null };
};

export function classifyStatus(facts: ResponseFacts): FailureKind | null {
  const { status } = facts;

  if (status < 400) return null;

  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";

  // Zen 在 key 失效、额度耗尽、封号时返回 402/404；归 auth 才会换 Worker 并冷却。
  if (status === 402 || status === 404) return "auth";

  if (status >= 400 && status < 500) return "bad_request";
  if (status >= 500) return "upstream_error";

  // 不可达，仅为满足返回类型；`unknown` 的真实来源只有 classifyError。
  return "unknown";
}

/** 这类失败换一个 Worker 有意义;bad_request 换了也一样失败。 */
export function isRetryable(kind: FailureKind): boolean {
  return (
    kind === "rate_limit" ||
    kind === "forbidden" ||
    kind === "upstream_error" ||
    kind === "transport" ||
    kind === "timeout"
  );
}

/** bad_request 不冷却：否则一个坏请求会把所有健康 Worker 逐个打进冷却（不变量 #4）。 */
export function shouldCooldown(kind: FailureKind): boolean {
  return kind !== "bad_request" && kind !== "unknown";
}

/**
 * 把异常分类为传输层失败。`depth` 与 `seen` 防止 `cause` 成环或超长链
 * 让错误处理函数自身栈溢出。
 */
export function classifyError(err: unknown, depth = 0, seen?: Set<unknown>): FailureKind {
  if (depth > 16) return "transport";

  if (err instanceof Error) {
    const name = err.name;
    if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") {
      return "timeout";
    }
    if (name === "AbortError") return "timeout";

    const code = (err as NodeJS.ErrnoException).code;
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "timeout";
    if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "EPIPE" ||
      code === "UND_ERR_SOCKET"
    ) {
      return "transport";
    }

    // fetch 把底层错误包在 cause 里。
    const cause = "cause" in err ? err.cause : undefined;
    if (cause !== undefined && cause !== err) {
      const visited = seen ?? new Set<unknown>();
      visited.add(err);
      if (!visited.has(cause)) return classifyError(cause, depth + 1, visited);
    }
    return "transport";
  }
  return "unknown";
}

/**
 * RFC 9110 的三种 HTTP-date 形态，必须严格匹配：宽松交给 `Date.parse` 会把缺时区
 * 的日期按本地时间解析、把裸月日解析到 2001 年，结果都算成 0（立刻重试）。
 */
const IMF_FIXDATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (?:GMT|UTC)$/;
const RFC_850 = /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} (?:GMT|UTC)$/;
const ASCTIME = /^[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * 解析 `Retry-After`（非负秒数或 HTTP-date）。畸形输入返回 null 用默认冷却，
 * 绝不能返回 0：刚被 429 就立刻重试只会招来更长的封禁。
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    // 上限 24h:畸形的巨大值会让 Worker 事实上永久消失。
    return Math.min(seconds * 1000, 86_400_000);
  }

  let at: number;
  if (IMF_FIXDATE.test(trimmed) || RFC_850.test(trimmed)) {
    at = Date.parse(trimmed);
  } else if (ASCTIME.test(trimmed)) {
    // asctime 不带时区，RFC 9110 规定按 UTC 理解。
    at = Date.parse(`${trimmed} UTC`);
  } else {
    return null;
  }

  if (Number.isNaN(at)) return null;

  const delta = at - now;
  // 合法但已过期的日期确实表示可立即重试。
  if (delta <= 0) return 0;
  return Math.min(delta, 86_400_000);
}
