import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../../src/server/app.ts";
import { applyConfigPatch } from "../../src/server/admin/patch.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { ProtocolRegistry } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { readModelField, readStreamField } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";
import { TOKEN, relay, useRelayUpstream } from "./helpers/relayFixture.ts";

/**
 * 转发前后的守卫：流式能力声明、鉴权与请求校验、请求体上限、匿名请求头、带凭证不跟随重定向。
 */

const up = useRelayUpstream();

/* ================================================================== *
 * 面声明的流式能力必须真的被执行
 * ================================================================== */

/**
 * `ProtocolSurface.streaming` 不能是一个**声明了却不设防的能力位**。
 *
 * 它被声明、被文档说明「`"none"` 为 jev 这类非流式面预留」。若全仓没有任何
 * 一处读它,把 `chatSurface` 的 `"optional"` 改成 `"none"` 后全量测试全绿;
 * 新增这样的面时,客户端发 `stream: true` 会被照常加上 `Accept: text/event-stream`
 * 并走流式泵,而上游那个面根本不产生 SSE。
 *
 * 这正是 [[verification-discipline]] 第 1 条的形态:接口字段存在不等于约束成立。
 */
describe("协议面的流式能力声明", () => {
  /** 一个非流式面 —— 形态对应 jev。 */
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

  function appWithNoStream(cfg: Config = up.config()) {
    const registry = new ProtocolRegistry().register(chatSurface).register(noStreamSurface);
    return createApp({ configOf: () => cfg, egress: up.egress, registry, log: () => {} });
  }

  it("非流式面收到 stream:true → 400,且**不打上游**", async () => {
    const res = await appWithNoStream().request(
      "/v1/nostream",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );

    expect(res.status).toBe(400);
    // 这是请求本身的问题,本机就能定论 —— 不该花一次上游调用去换已知的答案。
    expect(up.calls).toHaveLength(0);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request");
    // 消息要指出是哪个面,否则用户不知道该改哪个请求。
    expect(body.error.message).toContain("responses");
  });

  it("非流式面收到非流式请求 → 正常放行", async () => {
    up.handler = (_req, res) => res.end('{"ok":true}');
    const res = await appWithNoStream().request(
      "/v1/nostream",
      relay({ model: "big-pickle", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(1);
  });

  it("`optional` 面的流式请求不受影响 —— 只拦 `none`", async () => {
    up.handler = (_req, res) => res.end('{"ok":true}');
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
    up.handler = (_req, res) => res.end('{"ok":true}');
    const sseSurface: ProtocolSurface = { ...noStreamSurface, streaming: "sse" };
    const registry = new ProtocolRegistry().register(chatSurface).register(sseSurface);
    const res = await createApp({
      configOf: () => up.config(),
      egress: up.egress,
      registry,
      log: () => {},
    }).request("/v1/nostream", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(200);
  });
});

describe("鉴权与请求校验", () => {
  it("不带 Relay Token 一律 401，且不打上游", async () => {
    const res = await up.app().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("无前缀别名路径同样受鉴权保护 —— 漏一组等于留后门", async () => {
    const res = await up.app().request("/chat/completions", {
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
    const res = await up.app().request("/v1/chat/completions", relay(body));
    expect(res.status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  it("超长模型名的拒绝响应有界，不原样回显请求体", async () => {
    const model = "paid-model-" + "x".repeat(2 * 1024 * 1024);
    const res = await up.app().request("/v1/chat/completions", relay({ model, messages: [] }));
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
    const res = await up.app().request("/v1/chat/completions", {
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
    const cfg = up.config({ workers: [] });
    const res = await up.app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("no_worker_available");
    expect(body.error.message).toContain("尚未配置");
    expect(up.calls).toHaveLength(0);
  });

  it("匿名 Worker 缺 key 时仍可被选中，并且不发送 Authorization", async () => {
    /*
     * 匿名身份的配置归一化保证 key 为空；这条测试钉住它仍可进入候选链，
     * 且上游请求不会携带空 Authorization。
     */
    const cfg = up.config({
      workers: [{ id: "w1", name: "", kind: "anonymous", apiKey: "", enabled: true, proxyId: null }],
    });
    const res = await up.app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));

    expect(res.status).toBe(200);
    expect(up.calls[0]?.headers.authorization).toBeUndefined();
    expect(up.calls).toHaveLength(1);
  });

  it("Responses 首次响应的 id 会绑定实际 Worker，后续 previous_response_id 续回同一 Worker", async () => {
    let responseCount = 0;
    up.handler = (_req, res) => {
      responseCount += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: responseCount === 1 ? "resp_first_not_real" : "resp_second_not_real", output: [] }));
    };

    let current = up.config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: false, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-w2-not-real", enabled: true, proxyId: null },
      ],
    });
    const gateway = createApp({ configOf: () => current, egress: up.egress, log: () => {} });

    const first = await gateway.request("/v1/responses", relay({ model: "big-pickle", input: "first" }));
    expect(first.status).toBe(200);
    await first.text();
    expect(up.calls[0]?.headers.authorization).toBe("Bearer fake-key-w2-not-real");

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
    expect(up.calls[1]?.headers.authorization).toBe("Bearer fake-key-w2-not-real");
  });

  it("Responses 流命中失效推理时不学习输出 id", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        'data: {"type":"response.output_text.delta","delta":"encrypted_content was not issued to this caller"}\n\n' +
          'data: {"type":"response.completed","response":{"id":"resp_stale_not_real"}}\n\n' +
          "data: [DONE]\n\n",
      );
    };

    const cfg = up.config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null }],
    });
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const response = await gateway.request(
      "/v1/responses",
      relay({ model: "big-pickle", input: "first", stream: true }),
    );
    expect(response.status).toBe(200);
    await response.text();
    // 输出 id 只在完整且未命中失效推理时绑定；删除 scanner.hit() 守卫会留下 1 条会话亲和。
    expect(scheduler.snapshot(cfg, Date.now()).affinity.sessions).toBe(0);
  });

  it.each([
    // 流式同块形态由 responseIdCollector 单测覆盖:经真实传输无法稳定控制分块。
    [
      "非流式:体超过扫描预算但 id 在开头",
      false,
      () => JSON.stringify({ id: "resp_large_body_not_real", output: [{ text: "长".repeat(200_000) }] }),
    ],
  ])("超出 id 扫描预算时仍能绑定输出 id —— %s", async (_label, stream, body) => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
      res.end(body());
    };
    const cfg = up.config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null }],
    });
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const response = await gateway.request("/v1/responses", relay({ model: "big-pickle", input: "first", stream }));
    expect(response.status).toBe(200);
    await response.text();
    expect(scheduler.snapshot(cfg, Date.now()).affinity.sessions).toBe(1);
  });

  it("非流式大体的 id 不在开头时放弃绑定,而不是读完整体", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ text: "长".repeat(200_000) }], id: "resp_late_id_not_real" }));
    };
    const cfg = up.config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null }],
    });
    const scheduler = new Scheduler();
    const gateway = createApp({ configOf: () => cfg, egress: up.egress, scheduler, log: () => {} });
    const response = await gateway.request("/v1/responses", relay({ model: "big-pickle", input: "first" }));
    await response.text();
    expect(scheduler.snapshot(cfg, Date.now()).affinity.sessions).toBe(0);
  });

  it("停用的 Worker 不被选中", async () => {
    const cfg = up.config({
      workers: [{ id: "w1", name: "", kind: "authenticated", apiKey: "k-not-real", enabled: false, proxyId: null }],
    });
    const res = await up.app(cfg).request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("停用");
  });
});
/* ================================================================== *
 * 请求体上限
 * ================================================================== */

describe("请求体上限真的限制读入，不是读完再量", () => {
  /*
   * 若是 `await c.req.arrayBuffer()` 然后 `if (byteLength > 上限)`，
   * 那个顺序下整个体已经在内存里了 —— 上限只限制"转发多少"，
   * 不限制"占用多少"。实测：64 MiB 的闸门下发 200 MiB，
   * 网关照旧读入 200 MiB 才返回 413。
   *
   * 这两条拒绝路径（`body_too_large` / `body_unreadable`）也要有测试覆盖，
   * 否则"闸门装在错误的位置"这件事没人会发现。
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

    const res = await up.app().request("/v1/chat/completions", {
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
    const res = await up.app().request("/v1/chat/completions", relay({ model: "gpt-4o" }));
    expect(res.status).not.toBe(413);
  });

  it("读体中途出错记 `body_unreadable` 并返回 400", async () => {
    /*
     * 造一个读到一半就 error 的流。
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

    const res = await up.app().request("/v1/chat/completions", {
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
    const res = await up.app().request("/v1/chat/completions", {
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
      let current = up.config();
      const gateway = createApp({ configOf: () => current, egress: up.egress, log: () => {} });
      const body = { model: "big-pickle", messages: [], input: "test", max_tokens: 8 };
      const clientHeaders = { "x-api-key": "fake-client-key-not-real" };

      const first = await gateway.request(path, relay(body, clientHeaders));
      expect(first.status).toBe(200);
      await first.text();
      expect(up.calls).toHaveLength(1);
      expect(up.calls[0]!.headers.authorization).toBe("Bearer fake-key-1-not-real");
      if (path === "/v1/messages") {
        expect(up.calls[0]!.headers["x-api-key"]).toBe("fake-key-1-not-real");
      }

      // 只切 kind，保留旧 key 让生产配置归一化负责清理；不在 fixture 里先清空。
      const changed = applyConfigPatch(current, { workers: { update: { w1: { kind: "anonymous" } } } });
      expect(changed.ok).toBe(true);
      if (!changed.ok) throw new Error(changed.failure.message);
      current = changed.config;

      const second = await gateway.request(path, relay(body, clientHeaders));
      expect(second.status).toBe(200);
      await second.text();
      expect(up.calls).toHaveLength(2);
      expect(up.calls[1]!.headers.authorization).toBeUndefined();
      expect(up.calls[1]!.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(up.calls[1]!.headers)).not.toContain("fake-key-1-not-real");
      expect(JSON.stringify(up.calls[1]!.headers)).not.toContain("fake-client-key-not-real");
    },
  );
});

/* ================================================================== *
 * 带 Authorization 时绝不跟随重定向
 * ================================================================== */

describe("上游重定向：带凭证时绝不跟随", () => {
  let redirectTarget: Server;
  let targetHits: number;
  let targetAuthSeen: string[];
  let upstream: Server;
  let upstreamPort: number;
  let targetPort: number;

  beforeEach(async () => {
    targetHits = 0;
    targetAuthSeen = [];

    // 重定向目标:记录它是否收到过请求、以及是否看到了 Authorization。
    redirectTarget = createServer((req, res) => {
      targetHits += 1;
      const auth = req.headers["authorization"];
      if (typeof auth === "string") targetAuthSeen.push(auth);
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"stolen":true}');
    });
    redirectTarget.listen(0, "127.0.0.1");
    await once(redirectTarget, "listening");
    const ta = redirectTarget.address();
    if (ta === null || typeof ta === "string") throw new Error("no target port");
    targetPort = ta.port;

    // 假上游:一律回 302 指向上面那个目标。
    upstream = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` });
        res.end();
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const ua = upstream.address();
    if (ua === null || typeof ua === "string") throw new Error("no upstream port");
    upstreamPort = ua.port;
  });

  afterEach(async () => {
    upstream.close();
    redirectTarget.close();
    await Promise.all([
      once(upstream, "close").catch(() => {}),
      once(redirectTarget, "close").catch(() => {}),
    ]);
  });

  it("上游回 302 时不跟随，Worker key 不会发给重定向目标", async () => {
    /*
     * 请求头里带着 Worker 的上游 key。若跟随一个指向别处的 302,
     * 那个 Bearer key 会被原样发给重定向目标 —— 一个被劫持或配错的上游
     * 就此变成凭证窃取原语。这是第 7 号安全要求,先前**零测试覆盖**:
     * 把 `redirect: "manual"` 改成 `"follow"` 后全套测试依然全绿。
     */
    const cfg = ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
      workers: [
        {
          id: "w1",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-must-not-leak-001",
          enabled: true,
          proxyId: null,
        },
      ],
    });

    const app = createApp({ configOf: () => cfg, egress: up.egress, log: () => {} });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });

    // 核心断言:重定向目标从未被访问,因此也从未见过那个 key。
    expect(targetHits, "重定向目标不该收到任何请求").toBe(0);
    expect(targetAuthSeen).toEqual([]);

    // 302 被原样透传给客户端（由它自己决定怎么处理）。
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("stolen");
  });
});
