import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
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

describe("apiKey 的校验与自查消息", () => {
  const BAD_KEY = "zen-test-key-not-real\n000";

  it("坏 apiKey 报的是**指向配置**的消息,而不是笼统的头错误", () => {
    /*
     * 归因问题:含 CR/LF 的 key 会让 undici 在 fetch 时抛错,而那个失败被
     * `classifyError` 归为 `transport` → 客户端收到「502 上游不可达」,
     * 尽管请求根本没发出去。用户会去查网络和上游,而真实原因在配置里。
     */
    expect(() =>
      buildUpstreamHeaders({ clientHeaders: {}, apiKey: BAD_KEY, streaming: false, newId: fixedId }),
    ).toThrow(HeaderValidationError);

    try {
      buildUpstreamHeaders({ clientHeaders: {}, apiKey: BAD_KEY, streaming: false, newId: fixedId });
    } catch (err) {
      const e = err as InstanceType<typeof HeaderValidationError>;
      expect(e.headerName).toBe("authorization");
      expect(e.message).toContain("apiKey");
      // 绝不回显 key 本身 —— 这条消息会进日志与用户粘贴的报错。
      expect(e.message).not.toContain("zen-test-key");
    }
  });

  it("**镜像了 key 的面上也报同一条消息** —— 校验先于 extra 循环", () => {
    /*
     * 要防的归因错位:Messages 面把 key 镜像进 `extra`
     * (那是它能工作的前提,见 `protocols/messages.ts`),于是通用的
     * "协议面头值非法"**先命中**,上面那条刻意写的自查消息在那个面上
     * 永远走不到:
     *
     * ```
     * chat:     headerName=authorization  "...请检查配置中该 Worker 的 apiKey"
     * messages: headerName=x-api-key      "协议面头值非法"   ← 指错了方向
     * ```
     *
     * 用户看到"协议面头值非法"会去查协议实现,而真实原因是配置里那个 key
     * 粘贴时带进了换行。修法是把**校验**提到 `extra` 循环之前,
     * 而**赋值**仍留在最后(那个顺序保证网关的决定不可被覆盖,见下一条)。
     */
    try {
      buildUpstreamHeaders({
        clientHeaders: {},
        apiKey: BAD_KEY,
        streaming: false,
        // 复刻 Messages 面的形态:把 key 镜像进 extra。
        extra: { "anthropic-version": "2023-06-01", "x-api-key": BAD_KEY },
        newId: fixedId,
      });
      throw new Error("应当抛 HeaderValidationError");
    } catch (err) {
      const e = err as InstanceType<typeof HeaderValidationError>;
      expect(e.headerName, "必须指向 apiKey,不是 x-api-key").toBe("authorization");
      expect(e.message).toContain("apiKey");
      expect(e.message).not.toContain("zen-test-key");
    }
  });

  it("移动校验**没有**改变覆盖顺序 —— 网关的头仍不可被面或客户端覆盖", () => {
    /*
     * 反向钉子。校验提前了,但赋值必须仍在最后:若顺序被一起挪上去,
     * 一个面(或客户端)发的 `authorization` 就能覆盖掉 Worker key ——
     * 那是一个由面控制的凭证替换原语。
     */
    const h = buildUpstreamHeaders({
      clientHeaders: { authorization: "Bearer CLIENT-MUST-NOT-WIN" },
      apiKey: FAKE_KEY,
      streaming: false,
      extra: { authorization: "Bearer SURFACE-MUST-NOT-WIN", "x-api-key": FAKE_KEY },
      newId: fixedId,
    });
    expect(h["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(h)).not.toContain("MUST-NOT-WIN");
    // 面自己的头照常生效（它不与网关掌握的头同名）。
    expect(h["x-api-key"]).toBe(FAKE_KEY);
  });

  it("匿名 Worker 的空 key 不生成空 Authorization", () => {
    const h = buildUpstreamHeaders({ clientHeaders: {}, apiKey: "", streaming: false, newId: fixedId });
    expect(h.authorization).toBeUndefined();
  });

  it("匿名 Worker 的空白 key 也不生成 Authorization", () => {
    const h = buildUpstreamHeaders({ clientHeaders: {}, apiKey: "   ", streaming: false, newId: fixedId });
    expect(h.authorization).toBeUndefined();
  });
});

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

  it("x-opencode- 前缀不豁免凭证规则:x-opencode-api-key 被剥掉,身份头与普通头照常透传", () => {
    const h = build({
      "x-opencode-api-key": "CLIENT-SUPPLIED-KEY-000",
      "x-opencode-token": "CLIENT-SUPPLIED-KEY-001",
      "x-opencode-session": "ses_abc123",
      "x-opencode-feature": "on",
    });
    expect(h["x-opencode-api-key"]).toBeUndefined();
    expect(h["x-opencode-token"]).toBeUndefined();
    expect(h["x-opencode-session"]).toBe("ses_abc123");
    expect(h["x-opencode-feature"]).toBe("on");
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

/* ================================================================== *
 * 凭证类请求头不得转发给上游
 * ================================================================== */

describe("上游请求头：凭证与来源信息不得外泄", () => {
  function build(clientHeaders: Record<string, string>) {
    return buildUpstreamHeaders({
      clientHeaders,
      apiKey: "fake-worker-key-not-real",
      streaming: false,
    });
  }

  it.each([
    ["cookie（浏览器恶意页面 fetch 本地端口时会自动带上）", "cookie"],
    ["authentication（isSecretKey 唯一认不出的凭证头名）", "authentication"],
    ["api-key", "api-key"],
    ["x-goog-api-key", "x-goog-api-key"],
    ["x-oc-relay-key（redact.ts 已知的本项目凭证形态）", "x-oc-relay-key"],
    ["x-auth-token", "x-auth-token"],
    ["x-session-id", "x-session-id"],
  ])("凭证头不转发：%s", (_label, name) => {
    const h = build({ [name]: "SECRET-VALUE-MUST-NOT-LEAK" });
    expect(h[name]).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain("SECRET-VALUE-MUST-NOT-LEAK");
  });

  it("content-encoding 不转发 —— 我们转发的是原始未压缩字节", () => {
    /*
     * 这是 pipe.ts 在响应侧已修掉的同一个 bug 的**请求侧镜像**。
     * 残留一个 `gzip` 会让上游对明文做 gunzip,得到解码失败。
     */
    const h = build({ "content-encoding": "gzip" });
    expect(h["content-encoding"]).toBeUndefined();
  });

  it.each(["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"])(
    "客户端自称的来源不转发：%s",
    (name) => {
      // 我们不是反代链的一环。转发它会把内网拓扑泄露给上游,
      // 并代为断言一件我们从未验证过的事。
      const h = build({ [name]: "10.1.2.3" });
      expect(h[name]).toBeUndefined();
      expect(JSON.stringify(h)).not.toContain("10.1.2.3");
    },
  );

  it("OpenCode 的身份头原样保留;同前缀但像凭证的头被剥掉", () => {
    /*
     * 只有 `OPENCODE_IDENTITY_HEADERS` 名单豁免通用凭证规则。豁免整个前缀会让
     * `x-opencode-api-key` 这类客户端可控的头原样发往上游;代价是将来名字像凭证的
     * 新 `x-opencode-*` 头(如 `x-opencode-token-budget`)要先加进名单才能透传。
     */
    const h = build({
      "x-opencode-session": "ses_abc",
      "x-opencode-request": "req_1",
      "x-opencode-project": "proj",
      "x-opencode-client": "cli",
      "x-opencode-token-budget": "4096",
      "x-opencode-feature": "on",
    });
    expect(h["x-opencode-session"]).toBe("ses_abc");
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-feature"]).toBe("on");
    expect(h["x-opencode-token-budget"]).toBeUndefined();
  });

  it.each([
    "user-agent",
    "accept-language",
    "anthropic-version",
    "x-stainless-lang",
    "openai-beta",
    "x-request-id",
  ])("常规客户端头不被误剥：%s", (name) => {
    // 过度剥离的代价是功能故障。这组断言是通用凭证规则的误报守卫。
    const h = build({ [name]: "some-value" });
    expect(h[name]).toBe("some-value");
  });
});
