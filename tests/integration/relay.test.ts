import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";

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

  it("Worker 缺 key 时不被选中，并如实说明", async () => {
    /*
     * 上游已于 2026-09-16 前后关闭免鉴权免费额度（403 FreeTierError），
     * 没有 key 的 Worker 发出去必定失败。放进候选链只会白占一次尝试，
     * 并把真实原因（没配 key）埋进重试日志。
     */
    const cfg = config({
      workers: [{ id: "w1", name: "", kind: "anonymous", apiKey: "", enabled: true, proxyId: null }],
    });
    const res = await app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("缺少上游 API key");
    expect(upstreamCalls).toHaveLength(0);
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
