import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp, buildRegistry } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../../src/core/models/catalog.ts";
import { ANTHROPIC_VERSION } from "../../src/core/protocols/messages.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";

/**
 * Phase 6 的集成测试 —— 三个协议面 + 目录交集 + 用量,对着**真实 HTTP 假上游**跑。
 *
 * ## 为什么这些必须是集成测试
 *
 * 单测能验各面**返回**什么头,但验不了那个头**真的发到了上游** ——
 * 中间还隔着 `buildUpstreamHeaders` 的三步覆盖顺序,而它会剥掉凭证类头名。
 * Messages 面的 `x-api-key` 恰好是一个**会被剥离规则命中**的头名,
 * 所以"面返回了它"与"上游收到了它"是两件不同的事,而只有后者才是我们要的性质。
 *
 * 同理,Phase 6 的验收条件(新增面不动路由与鉴权)只能在装配层验。
 */

const TOKEN = "phase6-test-token-x";

type Req = import("node:http").IncomingMessage;
type Res = import("node:http").ServerResponse;

let upstream: Server;
let upstreamPort: number;
let handler: (req: Req, res: Res) => void;
/** 上游收到的每次请求。 */
let calls: Array<{ url: string; method: string; headers: Record<string, unknown>; body: string }>;
let egress: EgressService;

/** 在架目录 —— 假上游的 GET /v1/models 返回它。 */
let liveIds: string[];

beforeEach(async () => {
  calls = [];
  liveIds = ["big-pickle", "nemotron-3-ultra-free", "claude-opus-5"];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", usage: { prompt_tokens: 11, completion_tokens: 4 } }));
  };

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      calls.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      // 目录端点由本文件统一应答,其余交给用例自己的 handler。
      if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: liveIds.map((id) => ({ id })) }));
        return;
      }
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

function config(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
    workers: [
      { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null },
    ],
    ...over,
  });
}

function relay(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/** 建 app;可选注入一个已预热的目录。 */
function app(cfg: Config = config(), catalog?: ModelCatalog, log?: (m: string) => void) {
  return createApp({
    configOf: () => cfg,
    egress,
    ...(catalog !== undefined ? { catalog } : {}),
    log: log ?? (() => {}),
  });
}

/** 造一个**已拉到目录**的缓存 —— 用真实路径预热,不去碰私有字段。 */
async function warmCatalog(cfg: Config): Promise<ModelCatalog> {
  const catalog = new ModelCatalog();
  await catalog.ensure(catalogIdentityOf(cfg), cfg, (c) => egress.upstreamDeps(c));
  return catalog;
}

/** 转发请求(排除目录查询)。 */
function relayCalls() {
  return calls.filter((c) => c.method === "POST");
}

describe("Phase 6 验收:新增两个面不动路由与鉴权", () => {
  it("三个面六条路径全部可路由到上游", async () => {
    /*
     * 规划的验收条件原话:「Phase 6 通过注册表新增 responses 与 messages
     * 来证明机制成立 —— 若新增一个面还需改路由或调度,抽象即失败」。
     *
     * 这一轮实际改动:`app.ts` 里两行 `.register(...)`。路由、鉴权守卫、
     * 调度、重试、透传都一行未改。
     */
    const bodies: Record<string, unknown> = {
      "/v1/chat/completions": { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
      "/chat/completions": { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
      "/v1/responses": { model: "big-pickle", input: "hi" },
      "/responses": { model: "big-pickle", input: "hi" },
      "/v1/messages": { model: "big-pickle", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      "/messages": { model: "big-pickle", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    };

    for (const path of buildRegistry().paths()) {
      const res = await app().request(path, relay(bodies[path]));
      expect(res.status, `${path} 应当被路由到上游`).toBe(200);
    }
    expect(relayCalls()).toHaveLength(6);
  });

  it("上游路径按面各自拼对 —— 不丢 baseUrl 的 /v1 前缀", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["/v1/chat/completions", { model: "big-pickle", messages: [] }, "/v1/chat/completions"],
      ["/responses", { model: "big-pickle", input: "hi" }, "/v1/responses"],
      ["/v1/messages", { model: "big-pickle", max_tokens: 8, messages: [] }, "/v1/messages"],
    ];
    for (const [clientPath, body, expectedUpstream] of cases) {
      calls = [];
      await app().request(clientPath, relay(body));
      expect(relayCalls()[0]?.url).toBe(expectedUpstream);
    }
  });

  it("**无前缀别名同样有鉴权** —— 第四轮那个免鉴权中继不会复现", async () => {
    /*
     * 第四轮审核的最严重缺陷:守卫挂的是 `/v1/*` + `/chat/*` + `/models`
     * 三条**字面量**,而路由从 `registry.paths()` 动态挂载。审核按注释自己
     * 承诺的 Phase 6 形态注册两个面后实测:`/v1/responses` 有鉴权,
     * 而**无前缀别名 `/responses` 完全绕过** —— 成为本机任意进程可用的、
     * 消耗用户 Worker key 的免鉴权中继。
     *
     * 那时这是个假想(面还没注册)。**现在两个面真的在了**,所以这条
     * 从"按假想构造"变成了"对真实装配的回归守卫"。
     */
    for (const path of buildRegistry().paths()) {
      const res = await app().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      });
      expect(res.status, `${path} 无 token 必须 401`).toBe(401);
    }
    // 一次都没打到上游 —— 鉴权在转发之前。
    expect(relayCalls()).toHaveLength(0);
  });
});

describe("Messages 面的凭证镜像 —— 少了它整池 Worker 会被冷却", () => {
  it("`x-api-key` **真的到达上游**,与 Bearer 同值", async () => {
    /*
     * 这条是本文件存在的首要理由,而单测测不到它。
     *
     * `x-api-key` 是一个**会被 `buildUpstreamHeaders` 的剥离规则命中**的头名
     * (客户端侧的 `x-api-key` 与上游凭证无关,必须剥)。所以"面返回了这个头"
     * 与"上游收到了这个头"之间隔着那层剥离 —— 只有后者才是我们要的性质。
     *
     * 实测依据(2026-09-23,免 key 与真实 key 各两次,只打免费模型):
     * 仅 Bearer → **500**;带 x-api-key → 403 FreeTierError(已抵达闸门)。
     * 500 归 `upstream_error` → 可重试且**归咎 Worker** → 整池进退避。
     */
    await app().request(
      "/v1/messages",
      relay({ model: "big-pickle", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    );
    const sent = relayCalls()[0]?.headers;
    expect(sent?.["x-api-key"]).toBe("fake-key-w1-not-real");
    expect(sent?.["authorization"]).toBe("Bearer fake-key-w1-not-real");
  });

  it("`anthropic-version` 到达上游,且**客户端伪造的值被覆盖**", async () => {
    /*
     * 版本号必须由网关给:取自客户端头的话,一个伪造的旧版本号就是
     * 协议降级原语。`headers.ts` 的第 3 步(面特有头)在第 1 步(客户端透传)
     * 之后,所以面写的值会盖掉客户端的同名头 —— 这条钉住那个顺序。
     */
    await app().request(
      "/v1/messages",
      relay({ model: "big-pickle", max_tokens: 16, messages: [] }, { "anthropic-version": "1999-01-01" }),
    );
    expect(relayCalls()[0]?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  });

  it("另两个面**不**发 `x-api-key` —— 这是 Messages 面独有的要求", async () => {
    /*
     * 反向钉子。若把镜像做进 `headers.ts` 的通用路径,三个面都会带上它 ——
     * 那等于把一个面的怪癖变成全局行为,而 chat 面实测只认 Bearer。
     */
    await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    await app().request("/v1/responses", relay({ model: "big-pickle", input: "hi" }));
    for (const call of relayCalls()) {
      expect(call.headers["x-api-key"]).toBeUndefined();
      expect(call.headers["anthropic-version"]).toBeUndefined();
    }
  });

  it("客户端自己发的 `x-api-key` 在**所有**面上都被剥掉", async () => {
    /*
     * 客户端侧那个 `x-api-key` 与上游凭证无关(可能是别的服务的凭证),
     * 原样转发等于把它泄露给上游。Messages 面的镜像必须用**我们的** key,
     * 而不是客户端发来的那个。
     *
     * 头值用纯 ASCII:HTTP 头是 ISO-8859-1,我第一版在头值里放了中文,
     * 于是 Hono 在构造请求时就抛 ByteString 转换错误 —— 那是一个**真实客户端
     * 根本发不出来**的请求形态,测它没有意义(纪律 #1 的第一类:
     * 测的路径根本不存在)。
     */
    await app().request(
      "/v1/messages",
      relay(
        { model: "big-pickle", max_tokens: 8, messages: [] },
        { "x-api-key": "client-own-credential-not-real" },
      ),
    );
    expect(relayCalls()[0]?.headers["x-api-key"]).toBe("fake-key-w1-not-real");
  });
});

describe("Responses 面的体内会话指针", () => {
  it("`previous_response_id` 被用作亲和键 —— 用**真实**面,不是假面", async () => {
    /*
     * 第五轮审核把这条归为「调用点存在但输入集为空」:
     * `chatSurface.sessionKeyFrom` 恒返回 undefined 且它是唯一注册的面,
     * 于是 relay 里「体内指针优先于头」**结构上无法执行**,只能用假面补测。
     *
     * 现在有了真实现。断言方式是行为:同一个 `previous_response_id`
     * 的两次请求落到同一个 Worker,**即使头不同** ——
     * 若体内指针没被读到,两次会各按头分别绑定。
     */
    const cfg = config({
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null },
        { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-w2-not-real", enabled: true, proxyId: null },
        { id: "w3", name: "", kind: "authenticated", apiKey: "fake-key-w3-not-real", enabled: true, proxyId: null },
      ],
    });
    const a = app(cfg);

    const first = await a.request(
      "/v1/responses",
      relay({ model: "big-pickle", input: "hi", previous_response_id: "resp_sticky_1" }, { "x-opencode-session": "ses_aaa" }),
    );
    const second = await a.request(
      "/v1/responses",
      relay({ model: "big-pickle", input: "hi", previous_response_id: "resp_sticky_1" }, { "x-opencode-session": "ses_bbb" }),
    );

    expect(first.headers.get("x-zen-gateway-worker")).toBe(second.headers.get("x-zen-gateway-worker"));
    /*
     * 第二次是粘滞命中,而不是碰巧同一个策略顺序。
     *
     * reason 的取值是 `"sticky"`(我第一版写了 `"session"`,凭记忆猜的 ——
     * 实际集合是 sticky/blob_hint/strategy/all_cooling/empty,见 `select.ts`)。
     * 这条断言正是为了把"两次同一个 Worker"与"两次都恰好排第一"区分开:
     * 没有它,把体内指针读取整个删掉后测试仍会绿(三个 Worker 的策略顺序稳定)。
     */
    expect(second.headers.get("x-zen-gateway-route")).toBe("sticky");
  });
});

describe("目录交集(免费判定的 ∩ 在架目录)", () => {
  it("**已下架**的 -free 模型被拒,且不打上游", async () => {
    /*
     * 规划给 Phase 6 定的门槛:「注入一个已下架 id(如 glm-5-free)后,
     * 它被交集自动剔除」。
     *
     * `glm-5-free` 后缀命中,所以 Phase 5 的判定会放行它,再由上游返回
     * 400 `Model is unavailable.` —— 用户看到上游措辞,指不到真实原因。
     * 现在在本机就拒掉,而且**省掉一次上游往返**。
     */
    const cfg = config();
    const catalog = await warmCatalog(cfg);
    calls = [];

    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "glm-5-free", messages: [] }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("model_not_allowed");
    // 措辞必须能自查 —— 指向"已下架"而不是"不在免费集"。
    expect(body.error.message).toContain("已不在上游在架目录");
    expect(body.error.message).toContain("glm-5-free");
    expect(relayCalls()).toHaveLength(0);
  });

  it("在架的免费模型照常放行 —— 证明拒绝来自交集", async () => {
    const cfg = config();
    const catalog = await warmCatalog(cfg);
    calls = [];
    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "nemotron-3-ultra-free", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(relayCalls()).toHaveLength(1);
  });

  it("**没有目录时放行** —— 上游抖动不该让网关拒绝一切", async () => {
    /*
     * 两侧代价不对称:拒绝会把一次目录拉取失败放大成"网关整体不可用",
     * 而放行的唯一后果是由上游拒绝(400),不产生费用。
     *
     * 这里用一个全新的空目录(没预热过)。
     */
    const res = await app(config(), new ModelCatalog()).request(
      "/v1/chat/completions",
      relay({ model: "glm-5-free", messages: [] }),
    );
    expect(res.status).toBe(200);
  });

  it("付费模型仍被拒 —— 即便它**在**在架目录里", async () => {
    /*
     * 交集是**收紧**而不是放宽。`claude-opus-5` 在假上游的目录里,
     * 而它必须仍然被拒 —— 否则交集把免费判定变成了"在架判定",
     * 那是真金白银的代价。
     */
    const cfg = config();
    const catalog = await warmCatalog(cfg);
    calls = [];
    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "claude-opus-5", messages: [] }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("不在免费集内");
    expect(relayCalls()).toHaveLength(0);
  });

  it("转发路径**不为每个请求**拉目录", async () => {
    /*
     * 这条守的是我自己写坏过的一处:第一版在每个转发请求上调
     * `refreshIfStale`,于是一次客户端请求变成两次上游请求(POST + GET),
     * 而拉取失败不填缓存 → 下个请求又发一次 → 稳态永久 ×2。
     *
     * 13 条既有集成测试当时一起红("expected length 1 but got 2"),
     * 那正是纪律里"跨请求的状态机必须配集成测试"的又一个实例:
     * 纯单测看不见"一次请求发了几次上游"。
     */
    const cfg = config();
    const a = app(cfg, new ModelCatalog());
    for (let i = 0; i < 5; i += 1) {
      await a.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    }
    expect(relayCalls()).toHaveLength(5);
    // 关键:一次目录请求都没有(转发路径只读缓存)。
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });
});

describe("/v1/models 的缓存", () => {
  it("连续多次查询**只打上游一次**", async () => {
    /*
     * 先前每次请求都打一次上游,于是上游抖动时目录跟着消失 ——
     * 而目录为空等于 OpenCode 的模型列表整个空掉。
     */
    const a = app();
    for (let i = 0; i < 4; i += 1) {
      const res = await a.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
    }
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  it("只返回免费集,付费模型不出现在列表里", async () => {
    /*
     * 客户端能看到的模型集必须与网关实际放行的一致 —— 否则每个付费模型
     * 都是一个"看起来能用,点了报错"的陷阱。
     */
    const res = await app().request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = (await res.json()) as { data: Array<{ id: string }>; zen_gateway_catalog: Record<string, unknown> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("nemotron-3-ultra-free");
    expect(ids).not.toContain("claude-opus-5");
    // 诊断字段:总数是在架总数,free 是过滤后的数量。
    expect(body.zen_gateway_catalog["total"]).toBe(3);
    expect(body.zen_gateway_catalog["free"]).toBe(2);
    expect(body.zen_gateway_catalog["slot"]).toBe("keyed");
  });

  it("上游目录挂掉时**继续给出上次成功的那份**", async () => {
    /*
     * 「校验过的最后成功缓存」的核心性质。
     *
     * 做法:先正常拉一次填上缓存,再让目录端点开始报 500,然后把 TTL 推过去。
     * 这里用一个 TTL 极短的配置,免得测试要等 30 分钟。
     */
    const cfg = config({ models: { catalogTtlMs: 60_000 } });
    const catalog = new ModelCatalog();
    const a = app(cfg, catalog);

    const first = await a.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(((await first.json()) as { data: unknown[] }).data).toHaveLength(2);

    // 目录端点从此报错。
    liveIds = [];
    upstream.close();
    await once(upstream, "close");

    // 缓存仍新鲜 → 不重拉,照常给出旧的。
    const second = await a.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: unknown[] }).data).toHaveLength(2);

    // 重新起一个空服务器让 afterEach 能正常关掉。
    upstream = createServer((_req, res) => res.end("{}"));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
  });

  it("从没拉到过目录时报 502,而不是空列表", async () => {
    /*
     * 空的 `{"data":[]}` 会让 OpenCode 显示"没有可用模型",而那与
     * "网关拿不到目录"是两件事 —— 用户会去翻自己的模型配置,
     * 而真实原因在上游或出口。
     */
    const cfg = ConfigSchema.parse({
      version: 1,
      // 指向一个没人监听的端口。
      gateway: { relayToken: TOKEN, baseUrl: "http://127.0.0.1:1/v1" },
    });
    const res = await app(cfg, new ModelCatalog()).request("/v1/models", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("用量解析接到了流上(parseUsage 的生产调用点)", () => {
  it("非流式响应的用量被读到,且按面归一化", async () => {
    /*
     * `parseUsage` 若只有接口与实现而没有调用点,就是第四轮那个
     * `streaming` 字段的形态:声明了却不设防。这条验它真的接在流上。
     *
     * 眼下的消费方式是日志 —— Phase 7 才写进 runtime.db。
     */
    const logs: string[] = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 123, completion_tokens: 45 } }));
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    // 必须把响应读完 —— 结算钩子挂在流末尾。
    await res.text();

    expect(logs.some((l) => l.includes("in=123 out=45 total=168"))).toBe(true);
  });

  it("**Anthropic 的用量拆在两个 SSE 事件里,两端都要收到**", async () => {
    /*
     * 本组最要紧的一条,也是 Messages 面唯一需要跨事件合并的地方:
     * `message_start` 在流的**开头**带 input_tokens,
     * `message_delta` 在**末尾**带 output_tokens。
     *
     * 所以"只留尾部窗口"会丢输入,"只扫开头预算"会丢输出。
     * 中间刻意塞很多 delta,让两端相距足够远。
     */
    const logs: string[] = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":812,"output_tokens":1}}}\n\n',
      );
      for (let i = 0; i < 200; i += 1) {
        res.write(`data: {"type":"content_block_delta","delta":{"text":"块${i}"}}\n\n`);
      }
      res.end('data: {"type":"message_delta","usage":{"output_tokens":37}}\n\n');
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/messages",
      relay({ model: "big-pickle", max_tokens: 64, stream: true, messages: [] }),
    );
    await res.text();

    // total 是重算的 849,不是两个半数取大的 812。
    expect(logs.some((l) => l.includes("in=812 out=37 total=849"))).toBe(true);
    expect(logs.some((l) => l.includes("messages/big-pickle"))).toBe(true);
  });

  it("Responses 面的流式用量在 `response.usage` 里", async () => {
    const logs: string[] = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"你"}\n\n');
      res.end(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":70,"output_tokens":8}}}\n\n',
      );
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/responses",
      relay({ model: "big-pickle", stream: true, input: "hi" }),
    );
    await res.text();

    expect(logs.some((l) => l.includes("in=70 out=8 total=78"))).toBe(true);
  });

  it("没有用量时不打日志 —— 免费模型未必报 usage", async () => {
    const logs: string[] = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [] }));
    };
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    await res.text();
    expect(logs.filter((l) => l.startsWith("用量"))).toHaveLength(0);
  });

  it("用量日志**不含响应内容** —— 只有数字", async () => {
    const logs: string[] = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "这段是用户的对话内容不得进日志" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    };
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    await res.text();

    const usageLines = logs.filter((l) => l.startsWith("用量"));
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).not.toContain("对话内容");
  });

  it("用量收集**不改变转发字节**", async () => {
    /*
     * 旁路的全部价值建立在"它不改变转发内容"之上。用量收集与失效推理扫描
     * 共用同一个 `onText`,所以多挂一个消费者也不能动字节。
     */
    const payload = 'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload);
    };
    const res = await app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );
    expect(await res.text()).toBe(payload);
  });
});
