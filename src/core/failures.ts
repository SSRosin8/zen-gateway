/**
 * 失败分类。
 *
 * 分级冷却与重试判定都依赖这个分类,所以它必须是**纯函数**,
 * 且只看状态码与响应头 —— 绝不看响应体。
 *
 * 理由见规划的不变量 #1:一旦重试判定读了 body,重试链就必须先消费 body,
 * 而消费过的 body 无法再转发给客户端;更糟的是流式响应下「先发了字节又去重试」
 * 会让客户端收到拼接的两段响应。把「只看 status + headers」写成类型约束,
 * 这个错误就无法在后续阶段被偷偷引入。
 */

export type FailureKind =
  /** 限流。尊重 Retry-After,长冷却。 */
  | "rate_limit"
  /** 鉴权失败。短退避 —— 配错的 key 应该反复暴露,而不是安静消失 15 分钟。 */
  | "auth"
  /** 上游 5xx。可重试。 */
  | "upstream_error"
  /** 连接层失败(DNS/TCP/TLS/代理拒绝)。指数退避 + 抖动。 */
  | "transport"
  /** 超时。 */
  | "timeout"
  /** 请求本身的问题(400/422 等)。**不是 Worker 的错**,不该冷却它。 */
  | "bad_request"
  /** 分类不明。保守处理:不重试、不冷却。 */
  | "unknown";

/** 分类所需的最小信息 —— 故意不含 body,见文件头说明。 */
export type ResponseFacts = {
  status: number;
  /** 只需要能查头的接口,便于测试传普通对象。 */
  headers: { get(name: string): string | null };
};

export function classifyStatus(facts: ResponseFacts): FailureKind | null {
  const { status } = facts;

  // 2xx/3xx 不是失败。
  if (status < 400) return null;

  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";

  /*
   * 402/404 归入 auth 而非 bad_request。
   *
   * Zen 在 key 失效、额度耗尽、账号被封时都可能返回这两个码,
   * 而它们的共同处置是「换一个 Worker 并让这个短暂冷却」。
   * 归到 bad_request 会导致换 Worker 也不换 —— 同一个坏 key 反复失败。
   */
  if (status === 402 || status === 404) return "auth";

  if (status >= 400 && status < 500) return "bad_request";
  if (status >= 500) return "upstream_error";

  return "unknown";
}

/** 这类失败换一个 Worker 有意义;bad_request 换了也一样失败。 */
export function isRetryable(kind: FailureKind): boolean {
  return (
    kind === "rate_limit" ||
    kind === "upstream_error" ||
    kind === "transport" ||
    kind === "timeout"
  );
}

/**
 * 是否应当冷却这个 Worker。
 *
 * `bad_request` 必须返回 false:400/422 是客户端请求的问题,不是 Worker 的问题。
 * 若据此冷却,一个客户端的坏请求会把所有健康 Worker 逐个打进冷却
 * (规划的不变量 #4)。
 */
export function shouldCooldown(kind: FailureKind): boolean {
  return kind !== "bad_request" && kind !== "unknown";
}

/** 把异常分类为传输层失败。同样不看任何响应体。 */
export function classifyError(err: unknown): FailureKind {
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
    if ("cause" in err && err.cause !== undefined && err.cause !== err) {
      return classifyError(err.cause);
    }
    return "transport";
  }
  return "unknown";
}

/**
 * 解析 `Retry-After`。
 *
 * 两种合法形态:非负秒数,或 HTTP-date。上游给了就必须尊重 ——
 * 自己另算一个更短的冷却只会招来更严厉的限流。
 *
 * 畸形输入必须返回 null(用我们自己的默认冷却),**绝不能返回 0**:
 * 0 意味着「立刻重试」,而这个头几乎只出现在 429 上 —— 刚被限流就立刻
 * 重试是最糟的反应,通常换来更长的封禁。
 *
 * 这里踩过的坑:`Date.parse` 会把裸数字当年份或日期解析 ——
 * `Date.parse("-5")` 得到 2001-04-30,`"2026"` 得到 2026-01-01,`"99"` 得到 1998。
 * 于是 `-5`、`5.5`、`99` 这类垃圾会落进「日期已过期」分支并返回 0。
 * 因此 HTTP-date 分支必须先要求形如 HTTP-date:RFC 9110 的三种形态
 * (IMF-fixdate / RFC 850 / asctime)**都以星期名开头**,故要求首字符是字母。
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // 秒数形态:只接受纯非负整数。
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    // 上限 24h:畸形的巨大值会让 Worker 事实上永久消失。
    return Math.min(seconds * 1000, 86_400_000);
  }

  // HTTP-date 形态必须以星期名开头;裸数字与符号一律不进 Date.parse。
  if (!/^[A-Za-z]/.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  // 合法但已过期的日期确实表示「现在就可以重试」,0 在这里是对的。
  if (delta <= 0) return 0;
  return Math.min(delta, 86_400_000);
}
