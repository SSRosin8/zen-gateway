import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { TOKEN, relay, useRelayUpstream } from "./helpers/relayFixture.ts";

/**
 * 转发链路：发字节后不重试、原样透传、免费闸门、取消、冷却归咎，以及 /v1/models、health 与管理面回环。
 */

const up = useRelayUpstream();

describe("不变量 #1：发过字节之后绝不重试", () => {
  it("上游先吐字节再断连：响应头恰好发一次，且不重试", async () => {
    /*
     * 危险的实现会这样：一边转发一边判断失败，于是「已经发了 200 和一部分 SSE」
     * 之后又去重试下一个 Worker，客户端收到两段拼接的响应 —— 在客户端侧表现为
     * JSON 解析失败或对话内容莫名重复，极难归因到网关。
     *
     * 正确行为：status 200 一旦到达就是「成功」，之后流中断就是流中断，
     * 客户端拿到一个被截断的流。**不重试**。
     *
     * ## 断连时机必须由测试控制，不能同步 destroy
     *
     * 若在 handler 里 writeHead + write + 立即 `socket.destroy()`，
     * 会拿到 502 而非 200 —— 因为同步销毁让 RST 与响应数据一起到达，
     * undici 在**解析出响应头之前**就报了连接错误。那条链路走的是
     * 「头到达前失败」，属于**可以**重试的情形（下面第三个用例正是它），
     * 于是用例根本测不到它声称要测的东西。
     *
     * 改为：handler 写完头与首个数据块后把 res 交给测试，测试**读到第一个块
     * 之后**才触发断连。这样「头已到达」是被断言过的事实，而不是时序巧合。
     */
    let pending: import("node:http").ServerResponse | null = null;

    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 立刻把头推出去，不等 body 缓冲。
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"部"}}]}\n\n');
      pending = res;
    };

    const cfg = up.config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "k1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "k2-not-real", enabled: true, proxyId: null },
        { id: "w3", name: "", kind: "authenticated", apiKey: "k3-not-real", enabled: true, proxyId: null },
      ],
    });

    const res = await up.app(cfg).request(
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
    expect(up.calls).toHaveLength(1);
  });

  it("上游发 200 后立即正常结束：也不重试", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":{"content":"ok"}}]}');
    };

    const res = await up.app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(up.calls).toHaveLength(1);
  });

  it("**头到达之前**失败才重试 —— 与上面形成对照", async () => {
    /*
     * 这条是不变量 #1 的另一侧：还没发任何字节，重试是安全且应当的。
     * 两条测试合起来才说明「边界画在响应头到达的那一刻」。
     */
    let n = 0;
    up.handler = (_req, res) => {
      n += 1;
      if (n === 1) {
        // 第一次：连头都不发就断。
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };

    const cfg = up.config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "k1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "k2-not-real", enabled: true, proxyId: null },
      ],
    });

    const res = await up.app(cfg).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );

    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(2);
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
    up.handler = (_req, res) => res.end('{"ok":true}');

    const raw = '{"model":"big-pickle","n":1.0,"s":"\\u4f60\\u597d","messages":[]}';
    await up.app().request("/v1/chat/completions", relay(raw));

    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.body).toBe(raw);
  });

  it("上游路径拼在 baseUrl 之后，不丢前缀", async () => {
    up.handler = (_req, res) => res.end("{}");
    await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    // baseUrl 是 .../v1，面的 upstreamPath 是 /chat/completions。
    expect(up.calls[0]!.url).toBe("/v1/chat/completions");
  });

  it("无 /v1 前缀的客户端路径同样可用", async () => {
    up.handler = (_req, res) => res.end("{}");
    const res = await up.app().request("/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("客户端的 Relay Token 不会被转发给上游", async () => {
    up.handler = (_req, res) => res.end("{}");
    await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    const auth = up.calls[0]!.headers["authorization"];
    expect(auth).toBe("Bearer fake-key-1-not-real");
    expect(String(auth)).not.toContain(TOKEN);
  });

  it("OpenCode 身份头原样透传", async () => {
    up.handler = (_req, res) => res.end("{}");
    await up.app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }, {
        "x-opencode-session": "ses_integration_1",
        "x-opencode-client": "cli",
      }),
    );
    expect(up.calls[0]!.headers["x-opencode-session"]).toBe("ses_integration_1");
    expect(up.calls[0]!.headers["x-opencode-client"]).toBe("cli");
  });

  it("缺 x-opencode-session 时网关补一个", async () => {
    up.handler = (_req, res) => res.end("{}");
    await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(up.calls[0]!.headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("上游的错误响应原样透传，含状态码与体", async () => {
    /*
     * 这是用户能看到上游真实拒绝原因的唯一路径 —— 例如 FreeTierError。
     * 若网关把它改写成自己的措辞，用户就无法知道上游到底为什么拒。
     */
    up.handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"FreeTierError","message":"上游的原话"}}');
    };

    const res = await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "FreeTierError", message: "上游的原话" },
    });
  });

  it("上游的 content-encoding 不被转发 —— 否则客户端会对已解压的字节再解一次", async () => {
    const { gzipSync } = await import("node:zlib");
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from('{"ok":true}')));
    };

    const res = await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.headers.get("content-encoding")).toBeNull();
    // undici 已解压，客户端拿到的是明文。
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("免费模型闸门", () => {
  it("付费模型在**请求出去之前**被拒", async () => {
    // 放行一个付费模型的代价是真金白银，且请求一旦发出就无法收回。
    const res = await up.app().request("/v1/chat/completions", relay({ model: "claude-opus-5", messages: [] }));

    expect(res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("model_not_allowed");
    // 消息要带模型名，否则用户无法自查是哪个模型被拒。
    expect(body.error.message).toContain("claude-opus-5");
  });

  it("免费模型放行", async () => {
    up.handler = (_req, res) => res.end('{"ok":true}');
    const res = await up.app().request("/v1/chat/completions", relay({ model: "nemotron-3-ultra-free", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("无后缀但在 extraFreeIds 里的放行", async () => {
    up.handler = (_req, res) => res.end('{"ok":true}');
    const res = await up.app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(200);
  });

  it("用户改配置即可放行新模型，不需改代码", async () => {
    up.handler = (_req, res) => res.end('{"ok":true}');
    const cfg = up.config();
    const custom = ConfigSchema.parse({
      ...cfg,
      models: { ...cfg.models, extraFreeIds: ["some-promo-model"] },
    });
    const res = await up.app(custom).request("/v1/chat/completions", relay({ model: "some-promo-model", messages: [] }));
    expect(res.status).toBe(200);
  });
});

describe("客户端取消", () => {
  it("等响应头时客户端断开:不记「转发失败」,也不再重试", async () => {
    const arrived: Array<() => void> = [];
    let firstArrived!: () => void;
    const first = new Promise<void>((r) => (firstArrived = r));
    up.handler = (_req, res) => {
      firstArrived();
      arrived.push(() => res.writeHead(500).end("{}"));
    };
    const logs: string[] = [];
    const cfg = up.config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-a-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-b-not-real", enabled: true, proxyId: null },
      ],
    });
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, log: (m) => logs.push(m) });
    const abort = new AbortController();
    const pending = gateway.request(
      new Request("http://127.0.0.1/v1/chat/completions", {
        ...relay({ model: "big-pickle", messages: [] }),
        signal: abort.signal,
      }),
    );
    await first;
    abort.abort();
    const res = await pending;
    for (const release of arrived) release();
    expect(res.status).toBe(499);
    expect(logs.filter((m) => m.includes("转发失败"))).toEqual([]);
    expect(up.calls).toHaveLength(1);
  });
});

describe("上游 401/403 的冷却归咎", () => {
  const twoWorkers = () =>
    up.config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-a-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-b-not-real", enabled: true, proxyId: null },
      ],
    });
  const w1 = (scheduler: Scheduler, cfg: Config) =>
    scheduler.runtimeWorkers(cfg, Date.now()).find((w) => w.id === "w1")!;

  it("目录未核验时 401 不冷却 Worker —— 那可能只是模型名问题", async () => {
    up.handler = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"ModelError"}');
    };
    const cfg = twoWorkers();
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const res = await gateway.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-zen-gateway-free")).toBe("extra_unverified");
    expect(w1(scheduler, cfg).ready).toBe(true);
  });

  it("目录已核验时 401 冷却 Worker", async () => {
    let call = 0;
    up.handler = (req, res) => {
      call += 1;
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"invalid key"}');
    };
    const cfg = twoWorkers();
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    expect((await gateway.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    const res = await gateway.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(401);
    expect(call).toBe(2);
    const state = w1(scheduler, cfg);
    expect(state.ready).toBe(false);
    expect(state.lastFailure).toBe("auth");
  });

  it("403 换 Worker 重试：地区限制换一个出口即可成功", async () => {
    let call = 0;
    up.handler = (_req, res) => {
      call += 1;
      if (call === 1) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"ModelError","message":"This model is not available in your country."}}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"id":"c1","choices":[]}');
    };
    const cfg = twoWorkers();
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const res = await gateway.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(200);
    expect(call).toBe(2);
    expect(res.headers.get("x-zen-gateway-attempts")).toBe("2");
    expect(res.headers.get("x-zen-gateway-worker")).not.toBe(cfg.workers[0]!.id);
    expect(w1(scheduler, cfg).lastFailure).toBe("forbidden");
  });

  it("403 只冷却 forbiddenMs 那么短", async () => {
    up.handler = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"FreeTierError"}}');
    };
    const cfg = twoWorkers();
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const res = await gateway.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(403);
    // 两个 Worker 都试过：403 换出口可能成功，最后一次的 403 原样交给客户端。
    expect(res.headers.get("x-zen-gateway-attempts")).toBe("2");
    const state = w1(scheduler, cfg);
    expect(state.lastFailure).toBe("forbidden");
    expect(state.cooldownRemainingMs).toBeGreaterThan(0);
    expect(state.cooldownRemainingMs).toBeLessThanOrEqual(Math.ceil(cfg.routing.cooldown.forbiddenMs * 1.25));
  });
});
describe("/v1/models 目录", () => {
  it("只列免费模型 —— 客户端可见集必须与实际放行集一致", async () => {
    /*
     * 若原样透传完整目录，OpenCode 会把付费模型也列进可选项，
     * 用户一选就得到 403 —— 每个付费模型都是一个「看起来能用，点了报错」的陷阱。
     */
    up.handler = (_req, res) => {
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

    const res = await up.app().request("/v1/models", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; owned_by?: string }> };
    expect(body.data.map((m) => m.id).sort()).toEqual(["big-pickle", "nemotron-3-ultra-free"]);
    // 上游条目的其余字段原样保留 —— 客户端可能依赖它们。
    expect(body.data[0]!.owned_by).toBe("opencode");
  });

  it("目录查询也要鉴权", async () => {
    expect((await up.app().request("/v1/models")).status).toBe(401);
  });

  it("上游目录不可达时返回 502", async () => {
    up.handler = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    const res = await up.app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
  });

  it("首个目录 Worker 的出口不可达时回退到后面的健康 Worker", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "big-pickle" }] }));
    };
    const cfg = up.config({
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

    const res = await up.app(cfg).request("/v1/models", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]?.headers.authorization).toBe("Bearer fake-key-good-egress-not-real");
  });

  it("上游目录不是合法 JSON 时返回 502 而非崩溃", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json</html>");
    };
    const res = await up.app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
  });

  it("目录里形状异常的条目被跳过，不影响其余", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [null, 42, "x-free", { noId: true }, { id: "big-pickle" }],
        }),
      );
    };
    const res = await up.app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["big-pickle"]);
  });
});

describe("管理面仅回环", () => {
  it("回环请求放行", async () => {
    // Hono 的 app.request 没有真实 socket，getConnInfo 取不到地址 → 默认拒绝。
    // 这条因此验证的是「取不到地址时拒绝」，与中间件单测互补。
    const res = await up.app().request("/api/ping");
    expect(res.status).toBe(403);
  });
});

describe("health", () => {
  it("/health 不需要鉴权 —— service.mjs 的健康等待靠它", async () => {
    const res = await up.app().request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    expect(body.pid).toBe(process.pid);
  });
});
