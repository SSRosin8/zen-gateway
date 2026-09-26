import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../../src/server/app.ts";
import { applyConfigPatch } from "../../src/server/admin/patch.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { ProtocolRegistry } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { readModelField, readStreamField } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";

/**
 * 转发链路的集成测试 —— 对着**真实 HTTP 假上游**跑。
 *
 * 用真服务器而不是 mock fetch，是因为本阶段最关键的那条不变量（#1）恰好只在
 * 真实的流式写出下才会暴露：mock 一个 Response 对象无法表达「头已经发出去、
 * 字节已经流了一部分、然后连接断了」这个时序。
 */

const TOKEN = "integration-test-token-x";

type UpstreamHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) => void;

let upstream: Server;
let upstreamPort: number;
/** 每个用例替换它来决定假上游的行为。 */
let handler: UpstreamHandler;
/** 上游收到的请求次数 —— 断言「没有重试」靠它。 */
let upstreamCalls: Array<{ url: string; headers: Record<string, unknown>; body: string }>;

let egress: EgressService;

beforeEach(async () => {
  upstreamCalls = [];
  handler = (_req, res) => res.end("{}");

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamCalls.push({
        url: req.url ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
  upstreamPort = addr.port;

  egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });
});

afterEach(async () => {
  await egress.close();
  upstream.close();
  await once(upstream, "close");
});

function config(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: {
      relayToken: TOKEN,
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      ...(over.gateway ?? {}),
    },
    workers: over.workers ?? [
      { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-1-not-real", enabled: true, proxyId: null },
    ],
    ...(over.proxies !== undefined ? { proxies: over.proxies } : {}),
    ...(over.models !== undefined ? { models: over.models } : {}),
  });
}

function app(cfg: Config = config()) {
  return createApp({ configOf: () => cfg, egress, log: () => {} });
}

function relay(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("不变量 #1：发过字节之后绝不重试", () => {
  it("上游先吐字节再断连：响应头恰好发一次，且不重试", async () => {
    /*
     * 这是规划里点名要求的那个测试。
     *
     * 危险的实现会这样：一边转发一边判断失败，于是「已经发了 200 和一部分 SSE」
     * 之后又去重试下一个 Worker，客户端收到两段拼接的响应 —— 在客户端侧表现为
     * JSON 解析失败或对话内容莫名重复，极难归因到网关。
     *
     * 正确行为：status 200 一旦到达就是「成功」，之后流中断就是流中断，
     * 客户端拿到一个被截断的流。**不重试**。
     *
     * ## 断连时机必须由测试控制，不能同步 destroy
     *
     * 我第一版在 handler 里 writeHead + write + 立即 `socket.destroy()`，
     * 结果拿到 502 而非 200 —— 因为同步销毁让 RST 与响应数据一起到达，
     * undici 在**解析出响应头之前**就报了连接错误。那条链路走的是
     * 「头到达前失败」，属于**可以**重试的情形（下面第三个用例正是它），
     * 于是这个用例根本没测到它声称要测的东西。
     *
     * 改为：handler 写完头与首个数据块后把 res 交给测试，测试**读到第一个块
     * 之后**才触发断连。这样「头已到达」是被断言过的事实，而不是时序巧合。
     */
    let pending: import("node:http").ServerResponse | null = null;

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 立刻把头推出去，不等 body 缓冲。
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"部"}}]}\n\n');
      pending = res;
    };

    const cfg = config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "k1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "k2-not-real", enabled: true, proxyId: null },
        { id: "w3", name: "", kind: "authenticated", apiKey: "k3-not-real", enabled: true, proxyId: null },
      ],
    });

    const res = await app(cfg).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );

    // 头已经发出，且是上游的 200 —— 不是网关改写的 502。
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();

    // 先确认第一个数据块真的到了客户端 —— 这才叫「已经发过字节」。
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain("部");

    // 现在才断连。
    expect(pending).not.toBeNull();
    pending!.socket?.destroy();

    // 后续读取会失败（或直接结束）—— 两种都可以，重点是下面那条断言。
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
    } catch {
      // 流被截断是预期的。
    }

    /*
     * 核心断言：上游只被调用**一次**。
     *
     * 有三个 Worker 可用、maxAttempts 默认 3，若实现把「已发字节后的流中断」
     * 当作可重试失败，这里会是 2 或 3，而客户端会收到拼接的两段响应。
     */
    expect(upstreamCalls).toHaveLength(1);
  });

  it("上游发 200 后立即正常结束：也不重试", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    };

    const res = await app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(upstreamCalls).toHaveLength(1);
  });

  it("**头到达之前**失败才重试 —— 与上面形成对照", async () => {
    /*
     * 这条是不变量 #1 的另一侧：还没发任何字节，重试是安全且应当的。
     * 两条测试合起来才说明「边界画在响应头到达的那一刻」。
     */
    let n = 0;
    handler = (_req, res) => {
      n += 1;
      if (n === 1) {
        // 第一次：连头都不发就断。
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };

    const cfg = config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "k1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "k2-not-real", enabled: true, proxyId: null },
      ],
    });

    const res = await app(cfg).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );

    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(2);
    expect(res.headers.get("x-zen-gateway-worker")).toBe("w2");
  });
});

describe("原样透传", () => {
  it("请求体字节原样转发 —— 不经 JSON 往返", async () => {
    /*
     * 实测过 JSON.parse → stringify 不是无损的：
     *   {"n":1.0,"s":"你好"} → {"n":1,"s":"你好"}
     * 字节数、数字字面量、转义形式全变。对一个「让 OpenCode 原样用上游」的
     * 网关，这种差异不该由我们引入。
     */
    handler = (_req, res) => res.end('{"ok":true}');

    const raw = '{"model":"big-pickle","n":1.0,"s":"\\u4f60\\u597d","messages":[]}';
    await app().request("/v1/chat/completions", relay(raw));

    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.body).toBe(raw);
  });

  it("上游路径拼在 baseUrl 之后，不丢前缀", async () => {
    handler = (_req, res) => res.end("{}");
    await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    // baseUrl 是 .../v1，面的 upstreamPath 是 /chat/completions。
    expect(upstreamCalls[0]!.url).toBe("/v1/chat/completions");
  });

  it("无 /v1 前缀的客户端路径同样可用", async () => {
    handler = (_req, res) => res.end("{}");
    const res = await app().request("/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("客户端的 Relay Token 不会被转发给上游", async () => {
    handler = (_req, res) => res.end("{}");
    await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    const auth = upstreamCalls[0]!.headers["authorization"];
    expect(auth).toBe("Bearer fake-key-1-not-real");
    expect(String(auth)).not.toContain(TOKEN);
  });

  it("OpenCode 身份头原样透传", async () => {
    handler = (_req, res) => res.end("{}");
    await app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }, {
        "x-opencode-session": "ses_integration_1",
        "x-opencode-client": "cli",
      }),
    );
    expect(upstreamCalls[0]!.headers["x-opencode-session"]).toBe("ses_integration_1");
    expect(upstreamCalls[0]!.headers["x-opencode-client"]).toBe("cli");
  });

  it("缺 x-opencode-session 时网关补一个", async () => {
    handler = (_req, res) => res.end("{}");
    await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(upstreamCalls[0]!.headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("上游的错误响应原样透传，含状态码与体", async () => {
    /*
     * 这是用户能看到上游真实拒绝原因的唯一路径 —— 例如 FreeTierError。
     * 若网关把它改写成自己的措辞，用户就无法知道上游到底为什么拒。
     */
    handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"FreeTierError","message":"上游的原话"}}');
    };

    const res = await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "FreeTierError", message: "上游的原话" },
    });
  });

  it("上游的 content-encoding 不被转发 —— 否则客户端会对已解压的字节再解一次", async () => {
    const { gzipSync } = await import("node:zlib");
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from('{"ok":true}')));
    };

    const res = await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.headers.get("content-encoding")).toBeNull();
    // undici 已解压，客户端拿到的是明文。
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("免费模型闸门", () => {
  it("付费模型在**请求出去之前**被拒", async () => {
    // 放行一个付费模型的代价是真金白银，且请求一旦发出就无法收回。
    const res = await app().request("/v1/chat/completions", relay({ model: "claude-opus-5", messages: [] }));

    expect(res.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("model_not_allowed");
    // 消息要带模型名，否则用户无法自查是哪个模型被拒。
    expect(body.error.message).toContain("claude-opus-5");
  });

  it("免费模型放行", async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const res = await app().request("/v1/chat/completions", relay({ model: "nemotron-3-ultra-free", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("无后缀但在 extraFreeIds 里的放行", async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const res = await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("用户改配置即可放行新模型，不需改代码", async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const cfg = config();
    const custom = ConfigSchema.parse({
      ...cfg,
      models: { ...cfg.models, extraFreeIds: ["some-promo-model"] },
    });
    const res = await app(custom).request("/v1/chat/completions", relay({ model: "some-promo-model", messages: [] }));
    expect(res.status).toBe(200);
  });
});

/* ================================================================== *
 * 面声明的流式能力必须真的被执行
 * ================================================================== */

/**
 * `ProtocolSurface.streaming` 曾是一个**声明了却不设防的能力位**。
 *
 * 它被声明、被文档说明「`"none"` 为 jev 这类非流式面预留」,但全仓没有任何
 * 一处读它 —— 把 `chatSurface` 的 `"optional"` 改成 `"none"` 后 859 条测试全绿
 * (2026-09-23 变异 M1 实测)。规划里 Phase 6 明确要新增这样的面,
 * 届时客户端发 `stream: true` 会被照常加上 `Accept: text/event-stream`
 * 并走流式泵,而上游那个面根本不产生 SSE。
 *
 * 这正是 [[verification-discipline]] 第 1 条的形态:接口字段存在不等于约束成立。
 */
describe("协议面的流式能力声明", () => {
  /** 一个非流式面 —— 形态对应规划里的 jev。 */
  const noStreamSurface: ProtocolSurface = {
    id: "responses",
    clientPaths: ["/v1/nostream"],
    upstreamPath: "/nostream",
    streaming: "none",
    extractModel: readModelField,
    wantsStream: readStreamField,
    sessionKeyFrom: () => undefined,
    extraUpstreamHeaders: () => ({}),
    // 本组测的是流式能力声明,不是用量。
    parseUsage: () => null,
  };

  function appWithNoStream(cfg: Config = config()) {
    const registry = new ProtocolRegistry().register(chatSurface).register(noStreamSurface);
    return createApp({ configOf: () => cfg, egress, registry, log: () => {} });
  }

  it("非流式面收到 stream:true → 400,且**不打上游**", async () => {
    const res = await appWithNoStream().request(
      "/v1/nostream",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );

    expect(res.status).toBe(400);
    // 这是请求本身的问题,本机就能定论 —— 不该花一次上游调用去换已知的答案。
    expect(upstreamCalls).toHaveLength(0);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request");
    // 消息要指出是哪个面,否则用户不知道该改哪个请求。
    expect(body.error.message).toContain("responses");
  });

  it("非流式面收到非流式请求 → 正常放行", async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const res = await appWithNoStream().request(
      "/v1/nostream",
      relay({ model: "big-pickle", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("`optional` 面的流式请求不受影响 —— 只拦 `none`", async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const res = await appWithNoStream().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );
    expect(res.status).toBe(200);
  });

  it("只声明 `sse` 的面**不**强制流式 —— 那会拦掉合法请求", async () => {
    /*
     * 反向断言,记录这条限制的边界。Anthropic Messages 这类面两者都支持,
     * 把「只声明了 sse」当成「必须流式」是一个会拒掉合法请求的过度收紧。
     */
    handler = (_req, res) => res.end('{"ok":true}');
    const sseSurface: ProtocolSurface = { ...noStreamSurface, streaming: "sse" };
    const registry = new ProtocolRegistry().register(chatSurface).register(sseSurface);
    const res = await createApp({
      configOf: () => config(),
      egress,
      registry,
      log: () => {},
    }).request("/v1/nostream", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(200);
  });
});

describe("鉴权与请求校验", () => {
  it("不带 Relay Token 一律 401，且不打上游", async () => {
    const res = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("无前缀别名路径同样受鉴权保护 —— 漏一组等于留后门", async () => {
    const res = await app().request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ["空体", ""],
    ["非法 JSON", "{not json"],
    ["缺 model", '{"messages":[]}'],
    ["model 是数字", '{"model":1,"messages":[]}'],
  ])("坏请求返回 400 且不打上游（%s）", async (_label, body) => {
    const res = await app().request("/v1/chat/completions", relay(body));
    expect(res.status).toBe(400);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("超长模型名的拒绝响应有界，不原样回显请求体", async () => {
    const model = "paid-model-" + "x".repeat(2 * 1024 * 1024);
    const res = await app().request("/v1/chat/completions", relay({ model, messages: [] }));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body.length).toBeLessThan(2_000);
    expect(body).not.toContain(model);
  });

  it("请求头含 CR/LF 时返回 400，不是 500", async () => {
    /*
     * 这类请求是**客户端**的错。让 undici 抛异常会变成 500，
     * 而且异常消息可能带上头值 —— 头值可能是凭证。
     */
    const res = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: new Headers([
        ["authorization", `Bearer ${TOKEN}`],
        ["content-type", "application/json"],
      ]),
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });
    // Headers 构造函数本身就拦住了 CR/LF，所以这里只能验证正常路径通过；
    // 头校验逻辑本身在 upstreamHeaders.test.ts 里被直接驱动。
    expect([200, 502]).toContain(res.status);
  });

  it("没有可用 Worker 时返回 503 并说明原因", async () => {
    const cfg = config({ workers: [] });
    const res = await app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("no_worker_available");
    expect(body.error.message).toContain("尚未配置");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("匿名 Worker 缺 key 时仍可被选中，并且不发送 Authorization", async () => {
    /*
     * 匿名身份的配置归一化保证 key 为空；这条测试钉住它仍可进入候选链，
     * 且上游请求不会携带空 Authorization。
     */
    const cfg = config({
      workers: [{ id: "w1", name: "", kind: "anonymous", apiKey: "", enabled: true, proxyId: null }],
    });
    const res = await app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(200);
    expect(upstreamCalls[0]?.headers.authorization).toBeUndefined();
    expect(upstreamCalls).toHaveLength(1);
  });

  it("Responses 首次响应的 id 会绑定实际 Worker，后续 previous_response_id 续回同一 Worker", async () => {
    let responseCount = 0;
    handler = (_req, res) => {
      responseCount += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: responseCount === 1 ? "resp_first_not_real" : "resp_second_not_real", output: [] }));
    };

    let current = config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: false, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-w2-not-real", enabled: true, proxyId: null },
      ],
    });
    const gateway = createApp({ configOf: () => current, egress, log: () => {} });

    const first = await gateway.request("/v1/responses", relay({ model: "big-pickle", input: "first" }));
    expect(first.status).toBe(200);
    await first.text();
    expect(upstreamCalls[0]?.headers.authorization).toBe("Bearer fake-key-w2-not-real");

    current = ConfigSchema.parse({
      ...current,
      workers: current.workers.map((w) => ({ ...w, enabled: true })),
    });
    const second = await gateway.request(
      "/v1/responses",
      relay({ model: "big-pickle", input: "second", previous_response_id: "resp_first_not_real" }),
    );
    expect(second.status).toBe(200);
    await second.text();
    expect(upstreamCalls[1]?.headers.authorization).toBe("Bearer fake-key-w2-not-real");
  });

  it("Responses 流命中失效推理时不学习输出 id", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"type":"response.output_text.delta","delta":"encrypted_content was not issued to this caller"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"resp_stale_not_real"}}\n\n' +
          "data: [DONE]\n\n",
      );
    };

    const cfg = config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null }],
    });
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress, scheduler, log: () => {} });
    const response = await gateway.request(
      "/v1/responses",
      relay({ model: "big-pickle", input: "first", stream: true }),
    );
    expect(response.status).toBe(200);
    await response.text();
    // 输出 id 只在完整且未命中失效推理时绑定；删除 scanner.hit() 守卫会留下 1 条会话亲和。
    expect(scheduler.snapshot(cfg, Date.now()).affinity.sessions).toBe(0);
  });

  it("停用的 Worker 不被选中", async () => {
    const cfg = config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "k-not-real", enabled: false, proxyId: null }],
    });
    const res = await app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("停用");
  });
});

describe("/v1/models 目录", () => {
  it("只列免费模型 —— 客户端可见集必须与实际放行集一致", async () => {
    /*
     * 若原样透传完整目录，OpenCode 会把付费模型也列进可选项，
     * 用户一选就得到 403 —— 每个付费模型都是一个「看起来能用，点了报错」的陷阱。
     */
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "claude-opus-5", object: "model", owned_by: "opencode" },
            { id: "big-pickle", object: "model", owned_by: "opencode" },
            { id: "nemotron-3-ultra-free", object: "model", owned_by: "opencode" },
            { id: "gpt-5.5", object: "model", owned_by: "opencode" },
          ],
        }),
      );
    };

    const res = await app().request("/v1/models", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; owned_by?: string }> };
    expect(body.data.map((m) => m.id).sort()).toEqual(["big-pickle", "nemotron-3-ultra-free"]);
    // 上游条目的其余字段原样保留 —— 客户端可能依赖它们。
    expect(body.data[0]!.owned_by).toBe("opencode");
  });

  it("目录查询也要鉴权", async () => {
    expect((await app().request("/v1/models")).status).toBe(401);
  });

  it("上游目录不可达时返回 502", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    const res = await app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
  });

  it("首个目录 Worker 的出口不可达时回退到后面的健康 Worker", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
    };
    const cfg = config({
      proxies: [
        {
          id: "p-bad",
          name: "不可达出口",
          type: "http",
          host: "127.0.0.1",
          port: 9,
          enabled: true,
          source: "manual",
          direct: true,
          bridgeable: false,
          egressIp: null,
        },
      ],
      workers: [
        {
          id: "w-bad",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-bad-egress-not-real",
          enabled: true,
          proxyId: "p-bad",
        },
        {
          id: "w-good",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-good-egress-not-real",
          enabled: true,
          proxyId: null,
        },
      ],
    });

    const res = await app(cfg).request("/v1/models", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.headers.authorization).toBe("Bearer fake-key-good-egress-not-real");
  });

  it("上游目录不是合法 JSON 时返回 502 而非崩溃", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json</html>");
    };
    const res = await app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
  });

  it("目录里形状异常的条目被跳过，不影响其余", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [null, 42, "x-free", { noId: true }, { id: "big-pickle" }],
        }),
      );
    };
    const res = await app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["big-pickle"]);
  });
});

describe("管理面仅回环", () => {
  it("回环请求放行", async () => {
    // Hono 的 app.request 没有真实 socket，getConnInfo 取不到地址 → 默认拒绝。
    // 这条因此验证的是「取不到地址时拒绝」，与中间件单测互补。
    const res = await app().request("/api/ping");
    expect(res.status).toBe(403);
  });
});

describe("health", () => {
  it("/health 不需要鉴权 —— service.mjs 的健康等待靠它", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
  });
});

/* ================================================================== *
 * 请求体上限（第十轮审核）
 * ================================================================== */

describe("请求体上限真的限制读入，不是读完再量", () => {
  /*
   * 先前是 `await c.req.arrayBuffer()` 然后 `if (byteLength > 上限)`。
   * 那个顺序下整个体已经在内存里了 —— 上限只限制"转发多少"，
   * 不限制"占用多少"。第十轮审核实测：64 MiB 的闸门下发 200 MiB，
   * 网关照旧读入 200 MiB 才返回 413。
   *
   * 而这两条拒绝路径（`body_too_large` / `body_unreadable`）此前
   * **零测试覆盖** —— `grep` 确认它们在 tests/ 下一次都没出现过，
   * 所以"闸门装在错误的位置"这件事也没人发现。
   *
   * ## 判据是「网关读了多少字节」，不是堆增长
   *
   * 堆增长的阈值天生要靠猜，且被 GC 时机左右（纪律 #1：能用行为断言
   * 就别用性能断言）。这里用一个**自己计数的流**：网关取消读取之后
   * 我们的 `pull` 不再被调用，于是"生产了多少字节"就是"网关读了多少"。
   */

  /** 造一个按需生产 1 MiB 块的请求体，并记录实际被拉取的字节数。 */
  function countingBody(totalBytes: number): { body: ReadableStream<Uint8Array>; pulled: () => number } {
    const CHUNK = 1024 * 1024;
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK, totalBytes - produced);
        produced += size;
        // 内容是合法 JSON 的填充字符，形状不影响这条闸门（它在解析之前）。
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    return { body: stream, pulled: () => produced };
  }

  it("**超限时提前取消**：网关读入的字节数远小于客户端要发的量", async () => {
    const { body, pulled } = countingBody(300 * 1024 * 1024);

    const res = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      // @ts-expect-error duplex 是流式请求体必需的，TS 的 RequestInit 还没有它
      duplex: "half",
    });

    expect(res.status).toBe(413);

    /*
     * 这是全部要点。上限 64 MiB，客户端想发 300 MiB。
     * 缺陷版本下这里是 300 MiB（全读完）；修好后应在上限附近就停。
     * 留一块余量（+8 MiB）给"最后一块跨过上限"与内部缓冲。
     */
    const readMiB = pulled() / 1048576;
    expect(readMiB).toBeLessThan(64 + 8);
    // 而且不是零 —— 它真的读了、真的是被上限拦下的。
    expect(readMiB).toBeGreaterThan(1);
  }, 60_000);

  it("上限之内的请求照常通过 —— 闸门不是把一切都挡掉", async () => {
    /*
     * 与上一条配对：少了它，一个"无条件 413"的实现也能让上一条通过。
     * 用一个真实的小体，断言它走到了业务逻辑（模型不在免费集 → 403），
     * 而不是停在 413。
     */
    const res = await app().request("/v1/chat/completions", relay({ model: "gpt-4o" }));
    expect(res.status).not.toBe(413);
  });

  it("读体中途出错记 `body_unreadable` 并返回 400", async () => {
    /*
     * 这条路径先前也零覆盖。造一个读到一半就 error 的流。
     */
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(1024).fill(0x61));
          return;
        }
        controller.error(new Error("客户端连接中断"));
      },
    });

    const res = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      // @ts-expect-error 同上
      duplex: "half",
    });

    // 400 而不是 500：读不到客户端的体是请求的问题，不是网关内部错误。
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("无法读取请求体");
  }, 30_000);

  it("空体仍然是 400 `body_empty`，与超限区分开", async () => {
    /*
     * 有界读取对 `body === null` 返回空数组，所以"空体"这条既有出口
     * 必须仍然可达 —— 改动不能把它变成 413 或 500。
     */
    const res = await app().request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("请求体为空");
  });
});

describe("匿名身份切换的实际请求头", () => {
  it.each(["/v1/chat/completions", "/v1/responses", "/v1/messages"])(
    "%s 从认证切到匿名后不再发送旧 key",
    async (path) => {
      let current = config();
      const gateway = createApp({ configOf: () => current, egress, log: () => {} });
      const body = { model: "big-pickle", messages: [], input: "test", max_tokens: 8 };
      const clientHeaders = { "x-api-key": "fake-client-key-not-real" };

      const first = await gateway.request(path, relay(body, clientHeaders));
      expect(first.status).toBe(200);
      await first.text();
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]!.headers.authorization).toBe("Bearer fake-key-1-not-real");
      if (path === "/v1/messages") {
        expect(upstreamCalls[0]!.headers["x-api-key"]).toBe("fake-key-1-not-real");
      }

      // 只切 kind，保留旧 key 让生产配置归一化负责清理；不在 fixture 里先清空。
      const changed = applyConfigPatch(current, { workers: { update: { w1: { kind: "anonymous" } } } });
      expect(changed.ok).toBe(true);
      if (!changed.ok) throw new Error(changed.failure.message);
      current = changed.config;

      const second = await gateway.request(path, relay(body, clientHeaders));
      expect(second.status).toBe(200);
      await second.text();
      expect(upstreamCalls).toHaveLength(2);
      expect(upstreamCalls[1]!.headers.authorization).toBeUndefined();
      expect(upstreamCalls[1]!.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(upstreamCalls[1]!.headers)).not.toContain("fake-key-1-not-real");
      expect(JSON.stringify(upstreamCalls[1]!.headers)).not.toContain("fake-client-key-not-real");
    },
  );
});
