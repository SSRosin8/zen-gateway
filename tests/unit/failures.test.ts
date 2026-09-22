import { describe, expect, it } from "vitest";
import {
  classifyError,
  classifyStatus,
  isRetryable,
  parseRetryAfter,
  shouldCooldown,
  type FailureKind,
} from "../../src/core/failures.ts";

const headers = (map: Record<string, string> = {}) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

describe("classifyStatus", () => {
  it("2xx/3xx 不是失败", () => {
    for (const status of [200, 201, 204, 301, 302, 399]) {
      expect(classifyStatus({ status, headers: headers() })).toBeNull();
    }
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [408, "timeout"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [422, "bad_request"],
    [413, "bad_request"],
    [500, "upstream_error"],
    [502, "upstream_error"],
    [503, "upstream_error"],
  ] as Array<[number, FailureKind]>)("%i → %s", (status, kind) => {
    expect(classifyStatus({ status, headers: headers() })).toBe(kind);
  });

  it("402/404 归入 auth 而非 bad_request", () => {
    /*
     * Zen 在 key 失效、额度耗尽、账号被封时都可能返回这两个码,共同处置是
     * 「换一个 Worker 并让这个短暂冷却」。归到 bad_request 会导致换也不换 ——
     * 同一个坏 key 反复失败。
     */
    expect(classifyStatus({ status: 402, headers: headers() })).toBe("auth");
    expect(classifyStatus({ status: 404, headers: headers() })).toBe("auth");
  });

  it("只看 status 与 headers,不需要 body", () => {
    // 类型上就没有 body 字段 —— 一旦重试判定读了 body,重试链就必须先消费它,
    // 而消费过的 body 无法再转发给客户端(规划的不变量 #1)。
    const facts = { status: 429, headers: headers({ "retry-after": "30" }) };
    expect(classifyStatus(facts)).toBe("rate_limit");
    expect("body" in facts).toBe(false);
  });
});

describe("isRetryable", () => {
  it.each(["rate_limit", "upstream_error", "transport", "timeout"] as FailureKind[])(
    "%s 可重试",
    (kind) => {
      expect(isRetryable(kind)).toBe(true);
    },
  );

  it("bad_request 不可重试 —— 换 Worker 也一样失败", () => {
    expect(isRetryable("bad_request")).toBe(false);
  });

  it("auth 不可重试但要冷却", () => {
    /*
     * 这两个判定故意分开:auth 失败换 Worker 有意义(交给调度层换),
     * 但在同一个 Worker 上重试毫无意义。
     */
    expect(isRetryable("auth")).toBe(false);
    expect(shouldCooldown("auth")).toBe(true);
  });

  it("unknown 保守处理:不重试", () => {
    expect(isRetryable("unknown")).toBe(false);
  });
});

describe("shouldCooldown", () => {
  it("bad_request 绝不冷却 Worker", () => {
    /*
     * 400/422 是客户端请求的问题,不是 Worker 的问题。若据此冷却,
     * 一个客户端的坏请求会把所有健康 Worker 逐个打进冷却(不变量 #4)。
     */
    expect(shouldCooldown("bad_request")).toBe(false);
  });

  it("unknown 不冷却", () => {
    expect(shouldCooldown("unknown")).toBe(false);
  });

  it.each(["rate_limit", "auth", "upstream_error", "transport", "timeout"] as FailureKind[])(
    "%s 需要冷却",
    (kind) => {
      expect(shouldCooldown(kind)).toBe(true);
    },
  );
});

describe("classifyError", () => {
  const withCode = (code: string) => Object.assign(new Error("boom"), { code });

  it.each([
    ["ECONNREFUSED", "transport"],
    ["ECONNRESET", "transport"],
    ["ENOTFOUND", "transport"],
    ["EHOSTUNREACH", "transport"],
    ["EAI_AGAIN", "transport"],
    ["ETIMEDOUT", "timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
    ["UND_ERR_BODY_TIMEOUT", "timeout"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ] as Array<[string, FailureKind]>)("%s → %s", (code, kind) => {
    expect(classifyError(withCode(code))).toBe(kind);
  });

  it("识别 undici 的超时错误名", () => {
    const err = new Error("headers timeout");
    err.name = "HeadersTimeoutError";
    expect(classifyError(err)).toBe("timeout");
  });

  it("AbortError 归为 timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyError(err)).toBe("timeout");
  });

  it("穿透 fetch 包装的 cause", () => {
    // fetch 把底层错误包在 cause 里,只看外层会全部退化成 transport。
    const inner = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const outer = new TypeError("fetch failed");
    (outer as { cause?: unknown }).cause = inner;
    expect(classifyError(outer)).toBe("transport");
  });

  it("cause 指向自身时不无限递归", () => {
    const err = new Error("self");
    (err as { cause?: unknown }).cause = err;
    expect(classifyError(err)).toBe("transport");
  });

  it("非 Error 输入归为 unknown", () => {
    expect(classifyError("字符串")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
  });
});

describe("parseRetryAfter", () => {
  const NOW = Date.parse("2026-09-22T12:00:00.000Z");

  it("秒数形态", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
  });

  it("HTTP-date 形态", () => {
    expect(parseRetryAfter("Tue, 22 Sep 2026 12:01:00 GMT", NOW)).toBe(60_000);
  });

  it("已过期的 HTTP-date 归零而非负数", () => {
    expect(parseRetryAfter("Tue, 22 Sep 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it("缺失或畸形时返回 null", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
  });

  it.each(["-5", "5.5", "+5", "-1", "0.5", "1e3"])(
    "非纯整数的 %s 返回 null 而不是 0",
    (raw) => {
      /*
       * Date.parse 会把这类输入当年份或日期解析:"-5" → 2001-04-30、
       * "5.5" → 2001-05-04。它们曾落进「日期已过期」分支并返回 0,
       * 而 0 意味着「立刻重试」—— 这个头几乎只出现在 429 上,
       * 刚被限流就立刻重试通常换来更长的封禁。
       */
      expect(parseRetryAfter(raw, NOW)).toBeNull();
    },
  );

  it("纯整数一律按秒解析,哪怕它看起来像年份", () => {
    // RFC 9110:Retry-After 的裸整数就是延迟秒数。"2026" 是 2026 秒,不是年份。
    expect(parseRetryAfter("2026", NOW)).toBe(2_026_000);
    expect(parseRetryAfter("99", NOW)).toBe(99_000);
  });

  it("上限 24h —— 畸形的巨大值会让 Worker 事实上永久消失", () => {
    expect(parseRetryAfter("999999999", NOW)).toBe(86_400_000);
    expect(parseRetryAfter("Fri, 22 Sep 2028 12:00:00 GMT", NOW)).toBe(86_400_000);
  });

  it("容忍首尾空白", () => {
    expect(parseRetryAfter("  45  ", NOW)).toBe(45_000);
  });
});
