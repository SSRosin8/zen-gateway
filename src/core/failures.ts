/**
 * 失败分类。
 *
 * 分级冷却与重试判定都依赖这个分类,所以它必须是**纯函数**,
 * 且只看状态码与响应头 —— 绝不看响应体。
 *
 * 理由见不变量 #1:一旦重试判定读了 body,重试链就必须先消费 body,
 * 而消费过的 body 无法再转发给客户端;更糟的是流式响应下「先发了字节又去重试」
 * 会让客户端收到拼接的两段响应。把「只看 status + headers」写成类型约束,
 * 这个错误就无法在后续阶段被偷偷引入。
 */

/**
 * 全部失败类别。
 *
 * 类型由这个数组**推导**,而不是另写一份联合类型 —— 冷却与重试的测试需要
 * 「对每一个 kind 都断言一遍」,而那要求有一份运行期可枚举的清单。
 * 两份并行的清单必然分叉,且分叉方向是漏:新增一个 kind 时类型会更新、
 * 手写的数组不会,于是穷举测试静默地少测一项。
 */
export const FAILURE_KINDS = [
  /** 限流。尊重 Retry-After,长冷却。 */
  "rate_limit",
  /** 鉴权失败。短退避 —— 配错的 key 应该反复暴露,而不是安静消失 15 分钟。 */
  "auth",
  /**
   * 403。比 auth 更短的冷却，且换 Worker 重试:上游既用 403 表示免费闸门
   * (`FreeTierError`,按客户端请求形态、先于密钥校验)，也用它表示地区限制
   * (取决于出口)。不读 body 无法区分；后者换一个出口就可能成功，前者多试
   * 几次只多花 maxAttempts 以内的往返，最后一次的 403 仍原样交给客户端。
   */
  "forbidden",
  /** 上游 5xx。可重试。 */
  "upstream_error",
  /** 连接层失败(DNS/TCP/TLS/代理拒绝)。指数退避 + 抖动。 */
  "transport",
  /** 超时。 */
  "timeout",
  /** 请求本身的问题(400/422 等)。**不是 Worker 的错**,不该冷却它。 */
  "bad_request",
  /** 分类不明。保守处理:不重试、不冷却。 */
  "unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

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

  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
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

  /*
   * **不可达**（100–599 全枚举，这一行零命中）。
   *
   * 上面几条已经穷尽：2xx/3xx 走 `null`、4xx 走 `bad_request`、5xx 走
   * `upstream_error`。留着它只为满足返回类型（TS 看不出 number 的这几个区间
   * 是穷尽的）。
   *
   * **写明这一点，因为「保留一行永远不改变结果的代码比删掉它更危险」** ——
   * 下一个人会以为某些状态码走 `unknown` 这条保守路径，从而据此推断
   * 「有些响应不重试也不冷却」。`unknown` 的真实来源**只有** `classifyError`
   * （非 Error 抛出物），不是这里。
   */
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

/**
 * 是否应当冷却这个 Worker。
 *
 * `bad_request` 必须返回 false:400/422 是客户端请求的问题,不是 Worker 的问题。
 * 若据此冷却,一个客户端的坏请求会把所有健康 Worker 逐个打进冷却
 * (不变量 #4)。
 */
export function shouldCooldown(kind: FailureKind): boolean {
  return kind !== "bad_request" && kind !== "unknown";
}

/** 把异常分类为传输层失败。同样不看任何响应体。 */
/**
 * 把异常分类为传输层失败。同样不看任何响应体。
 *
 * `depth` 与 `seen` 是必需的防护:`cause` 链可能成环。第一版只判断了
 * `err.cause !== err`(自指),而 `a.cause = b; b.cause = a` 这种两环会直接
 * 递归到 `RangeError: Maximum call stack size exceeded` —— **异常从错误处理
 * 函数里抛出来**,把一次可分类的传输失败变成进程级崩溃。超长链(两万层)同理。
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
 * RFC 9110 允许的三种 HTTP-date 形态。
 *
 * 必须逐形态严格匹配,不能只检查「首字符是字母」就交给 `Date.parse` ——
 * 实测那样会放过三类输入并把它们算成 0(= 立刻重试):
 *
 *   1. **缺时区的 IMF-fixdate**：`"Tue, 22 Sep 2026 07:00:00"`(无 GMT)
 *      被当作**本地时间**解析。在 UTC+8 的机器上,任何 8 小时内的未来时刻
 *      都会算出 `delta <= 0`。
 *   2. **asctime**：`"Tue Sep 22 00:05:00 2026"` 本身不带时区,同样按本地时间解析。
 *   3. **裸月日**：`"Nov 6"`、`"March 5"` 通过了首字母检查,而 `Date.parse`
 *      把它们解析到 2001 年 —— 早已过期,于是返回 0。
 *
 * 这和最初 `"-5"` 被解析成 2001-04-30 是同一类 bug,只是换了个入口。
 */
const IMF_FIXDATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (?:GMT|UTC)$/;
const RFC_850 = /^[A-Za-z]{6,9}, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} (?:GMT|UTC)$/;
const ASCTIME = /^[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * 解析 `Retry-After`。
 *
 * 两种合法形态:非负秒数,或 HTTP-date。上游给了就必须尊重 ——
 * 自己另算一个更短的冷却只会招来更严厉的限流。
 *
 * 畸形输入必须返回 null(用我们自己的默认冷却),**绝不能返回 0**:
 * 0 意味着「立刻重试」,而这个头几乎只出现在 429 上 —— 刚被限流就立刻
 * 重试是最糟的反应,通常换来更长的封禁。
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

  // HTTP-date:必须严格匹配三种形态之一,且时区明确。
  let at: number;
  if (IMF_FIXDATE.test(trimmed) || RFC_850.test(trimmed)) {
    at = Date.parse(trimmed);
  } else if (ASCTIME.test(trimmed)) {
    // asctime 不带时区,RFC 9110 规定按 UTC 理解;显式补上,否则按本地时间解析。
    at = Date.parse(`${trimmed} UTC`);
  } else {
    return null;
  }

  if (Number.isNaN(at)) return null;

  const delta = at - now;
  // 合法但已过期的日期确实表示「现在就可以重试」,0 在这里是对的。
  if (delta <= 0) return 0;
  return Math.min(delta, 86_400_000);
}
