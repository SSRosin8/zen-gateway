import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  collectHeaders,
  HeaderValidationError,
  isSafeHeaderName,
  isSafeHeaderValue,
  OPENCODE_IDENTITY_HEADERS,
} from "../../src/core/upstream/headers.ts";

const FAKE_KEY = "zen-test-key-not-real-000";
const fixedId = () => "11111111-2222-3333-4444-555555555555";

function build(clientHeaders: Record<string, string>, over: Partial<{ streaming: boolean; extra: Record<string, string> }> = {}) {
  return buildUpstreamHeaders({
    clientHeaders,
    apiKey: FAKE_KEY,
    streaming: over.streaming ?? false,
    ...(over.extra !== undefined ? { extra: over.extra } : {}),
    newId: fixedId,
  });
}

describe("剥离不可转发的头", () => {
  it("客户端的 Authorization 绝不转发给上游", () => {
    /*
     * 这是本文件最重要的一条断言。
     *
     * 客户端侧的 Authorization 带的是**本网关的 Relay Token**,与上游凭证无关。
     * 原样转发等于把本机网关口令泄露给上游,而且会覆盖掉我们要设的 Worker key。
     */
    const h = build({ authorization: "Bearer RELAY-TOKEN-MUST-NOT-LEAK" });
    expect(h["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(h)).not.toContain("RELAY-TOKEN-MUST-NOT-LEAK");
  });

  it("客户端的 x-api-key 也被剥掉", () => {
    const h = build({ "x-api-key": "CLIENT-SUPPLIED-KEY-000" });
    expect(h["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain("CLIENT-SUPPLIED-KEY-000");
  });

  it.each([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-connection",
    "host",
    "content-length",
    "accept-encoding",
  ])("逐跳头/重算头 %s 不转发", (name) => {
    const h = build({ [name]: "whatever" });
    expect(h[name]).not.toBe("whatever");
  });

  it("大写的 Authorization 同样被剥掉 —— 头名比较必须大小写不敏感", () => {
    // 只比小写会漏掉 `Authorization:`,而那是最常见的写法。
    const h = build({ Authorization: "Bearer LEAKED-TOKEN-999" });
    expect(JSON.stringify(h)).not.toContain("LEAKED-TOKEN-999");
  });
});

describe("原样透传 OpenCode 身份头", () => {
  it("客户端给的 session 与 request 原样保留", () => {
    const h = build({
      "x-opencode-session": "ses_abc123",
      "x-opencode-request": "req_xyz",
      "x-opencode-project": "my-project",
      "x-opencode-client": "cli",
    });
    expect(h["x-opencode-session"]).toBe("ses_abc123");
    expect(h["x-opencode-request"]).toBe("req_xyz");
    expect(h["x-opencode-project"]).toBe("my-project");
    expect(h["x-opencode-client"]).toBe("cli");
  });

  it("缺 session 时合成 —— 它是 chat 面唯一的亲和依据", () => {
    /*
     * chat 面的请求体里没有会话标识,缺了这个头会让每个请求被当成新会话:
     * 粘滞失效 → 每次可能换 Worker → 上游侧推理连续性与缓存命中一起失去。
     */
    const h = build({});
    expect(h["x-opencode-session"]).toBe(fixedId());
    expect(h["x-opencode-request"]).toBe(fixedId());
  });

  it("不合成 project 与 client —— 网关替客户端编造会污染上游统计", () => {
    const h = build({});
    expect(h["x-opencode-project"]).toBeUndefined();
    expect(h["x-opencode-client"]).toBeUndefined();
  });

  it("身份头常量与实际透传的一致", () => {
    const supplied = Object.fromEntries(OPENCODE_IDENTITY_HEADERS.map((n) => [n, `v-${n}`]));
    const h = build(supplied);
    for (const name of OPENCODE_IDENTITY_HEADERS) {
      expect(h[name]).toBe(`v-${name}`);
    }
  });
});

describe("头值校验", () => {
  /*
   * 控制字符用 String.fromCharCode 构造，**不写字面控制字节**。
   * 源码里的字面控制字节会被编辑器与工具静默改写（本项目在 redact.ts 已踩过，
   * 那里因此改用逐码点循环而非正则），于是「测试里写的」与「实际断言的」
   * 不再是同一个值 —— 一道校验关卡就此变成绿着的空壳。
   */
  it.each([
    ["CR", `a${String.fromCharCode(0x0d)}b`],
    ["LF", `a${String.fromCharCode(0x0a)}b`],
    ["CRLF 注入", `a${String.fromCharCode(0x0d, 0x0a)}X-Injected: 1`],
    ["NUL", `a${String.fromCharCode(0x00)}b`],
    ["垂直制表", `a${String.fromCharCode(0x0b)}b`],
    ["DEL", `a${String.fromCharCode(0x7f)}b`],
  ])("%s 被拒", (_label, value) => {
    expect(isSafeHeaderValue(value)).toBe(false);
    expect(() => build({ "x-custom": value })).toThrow(HeaderValidationError);
  });

  it("拒绝时的消息不含头值 —— 值可能是凭证", () => {
    const secret = "SECRET-VALUE-IN-HEADER-777";
    try {
      build({ "x-custom": `${secret}\r\ninjected: 1` });
      expect.unreachable("应当抛出");
    } catch (err) {
      expect(err).toBeInstanceOf(HeaderValidationError);
      expect((err as Error).message).not.toContain(secret);
      expect((err as HeaderValidationError).headerName).toBe("x-custom");
    }
  });

  it.each([
    ["普通 ASCII", "hello-world"],
    ["含空格", "Mozilla/5.0 (X11; Linux)"],
    ["含中文", "项目名"],
    ["制表符外的高位字符", "café"],
  ])("合法值通过（%s）", (_label, value) => {
    expect(isSafeHeaderValue(value)).toBe(true);
  });

  it.each([
    ["含空格", "x custom"],
    ["含冒号", "x:custom"],
    ["含换行", "x\ncustom"],
    ["空串", ""],
    ["含括号", "x(custom)"],
  ])("非法头名被拒（%s）", (_label, name) => {
    expect(isSafeHeaderName(name)).toBe(false);
  });

  it("合法头名通过", () => {
    for (const n of ["x-custom", "content-type", "x_under", "a.b", "a1~b|c"]) {
      expect(isSafeHeaderName(n)).toBe(true);
    }
  });
});

describe("网关掌握的头不可被客户端覆盖", () => {
  it("客户端发 content-type 也会被网关的值压过", () => {
    const h = build({ "content-type": "text/plain" });
    expect(h["content-type"]).toBe("application/json");
  });

  it("流式与非流式的 accept 不同", () => {
    expect(build({}, { streaming: true })["accept"]).toBe("text/event-stream");
    expect(build({}, { streaming: false })["accept"]).toBe("application/json");
  });

  it("客户端发 accept 无法改变网关的决定", () => {
    // 否则客户端能让「非流式请求」带上 SSE 的 accept,与 body 里的 stream 冲突。
    const h = build({ accept: "text/event-stream" }, { streaming: false });
    expect(h["accept"]).toBe("application/json");
  });

  it("协议面的 extra 头无法覆盖鉴权", () => {
    /*
     * 顺序保证:面特有头在第 3 步,网关掌握的头在第 4 步。
     * 反过来的话,一个面（或被污染的面实现）就能改写鉴权。
     */
    const h = build({}, { extra: { authorization: "Bearer HIJACKED-000" } });
    expect(h["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("协议面可以加自己的头（如 anthropic-version）", () => {
    const h = build({}, { extra: { "anthropic-version": "2023-06-01" } });
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("协议面的非法头值同样被拒", () => {
    expect(() => build({}, { extra: { "x-bad": "a\r\nb" } })).toThrow(HeaderValidationError);
  });
});

describe("collectHeaders", () => {
  it("头名统一小写", () => {
    const hs = new Headers();
    hs.set("Content-Type", "application/json");
    hs.set("X-Custom", "v");
    expect(collectHeaders(hs)).toEqual({ "content-type": "application/json", "x-custom": "v" });
  });
});
