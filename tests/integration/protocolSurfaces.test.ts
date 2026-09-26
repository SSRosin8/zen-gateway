import { describe, expect, it } from "vitest";
import { buildRegistry } from "../../src/server/app.ts";
import { ANTHROPIC_VERSION } from "../../src/core/protocols/messages.ts";
import { TOKEN, useSurfaceFixture } from "./helpers/surfaceFixture.ts";

/**
 * 协议面集成测试 —— chat / responses / messages 三个面,对着**真实 HTTP 假上游**跑。
 *
 * ## 为什么这些必须是集成测试
 *
 * 单测能验各面**返回**什么头,但验不了那个头**真的发到了上游** ——
 * 中间还隔着 `buildUpstreamHeaders` 的三步覆盖顺序,而它会剥掉凭证类头名。
 * Messages 面的 `x-api-key` 恰好是一个**会被剥离规则命中**的头名,
 * 所以"面返回了它"与"上游收到了它"是两件不同的事,而只有后者才是我们要的性质。
 *
 * 同理,「新增面不动路由与鉴权」这一性质只能在装配层验。
 */

const { up, config, relay, app } = useSurfaceFixture();

describe("新增协议面不动路由与鉴权", () => {
  it("三个面六条路径全部可路由到上游", async () => {
    /*
     * 通过注册表新增 responses 与 messages 来证明机制成立 —— 若新增一个面
     * 还需改路由或调度,抽象即失败。新增面在 `app.ts` 里只应是 `.register(...)`,
     * 路由、鉴权守卫、调度、重试、透传都不该跟着改。
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
    expect(up.relayCalls()).toHaveLength(6);
  });

  it("上游路径按面各自拼对 —— 不丢 baseUrl 的 /v1 前缀", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["/v1/chat/completions", { model: "big-pickle", messages: [] }, "/v1/chat/completions"],
      ["/responses", { model: "big-pickle", input: "hi" }, "/v1/responses"],
      ["/v1/messages", { model: "big-pickle", max_tokens: 8, messages: [] }, "/v1/messages"],
    ];
    for (const [clientPath, body, expectedUpstream] of cases) {
      up.calls = [];
      await app().request(clientPath, relay(body));
      expect(up.relayCalls()[0]?.url).toBe(expectedUpstream);
    }
  });

  it("**无前缀别名同样有鉴权** —— 免鉴权中继不会复现", async () => {
    /*
     * 若守卫挂的是 `/v1/*` + `/chat/*` + `/models` 三条**字面量**,而路由从
     * `registry.paths()` 动态挂载,注册两个面后 `/v1/responses` 有鉴权,
     * 而**无前缀别名 `/responses` 完全绕过** —— 成为本机任意进程可用的、
     * 消耗用户 Worker key 的免鉴权中继。这条对真实装配逐条路径验证。
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
    expect(up.relayCalls()).toHaveLength(0);
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
    const sent = up.relayCalls()[0]?.headers;
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
    expect(up.relayCalls()[0]?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  });

  it("另两个面**不**发 `x-api-key` —— 这是 Messages 面独有的要求", async () => {
    /*
     * 反向钉子。若把镜像做进 `headers.ts` 的通用路径,三个面都会带上它 ——
     * 那等于把一个面的怪癖变成全局行为,而 chat 面实测只认 Bearer。
     */
    await app().request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    await app().request("/v1/responses", relay({ model: "big-pickle", input: "hi" }));
    for (const call of up.relayCalls()) {
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
     * 头值用纯 ASCII:HTTP 头是 ISO-8859-1,头值里放中文时
     * Hono 在构造请求时就抛 ByteString 转换错误 —— 那是一个**真实客户端
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
    expect(up.relayCalls()[0]?.headers["x-api-key"]).toBe("fake-key-w1-not-real");
  });
});

describe("Messages 面接受 x-api-key 形式的 Relay Token", () => {
  const messagesBody = { model: "big-pickle", max_tokens: 8, messages: [] };
  const withHeaders = (headers: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(messagesBody),
  });

  it("只带 x-api-key 的 Messages 请求放行,且上游收不到客户端的 x-api-key", async () => {
    for (const path of ["/v1/messages", "/messages"]) {
      up.calls = [];
      const res = await app().request(path, withHeaders({ "x-api-key": TOKEN }));
      expect(res.status, path).toBe(200);
      const sent = up.relayCalls()[0]?.headers;
      // 认证 Worker 的 key 被镜像进去,而 Relay Token 绝不能到上游。
      expect(sent?.["x-api-key"]).toBe("fake-key-w1-not-real");
      expect(JSON.stringify(sent)).not.toContain(TOKEN);
    }
  });

  it("匿名 Worker 转发时不带任何 x-api-key,客户端那个也不漏过去", async () => {
    const cfg = config({
      workers: [{ id: "a1", name: "", kind: "anonymous", apiKey: "", enabled: true, proxyId: null }],
    });
    const res = await app(cfg).request("/v1/messages", withHeaders({ "x-api-key": TOKEN }));
    expect(res.status).toBe(200);
    const sent = up.relayCalls()[0]?.headers;
    expect(sent?.["x-api-key"]).toBeUndefined();
    expect(sent?.["authorization"]).toBeUndefined();
  });

  it("错误的 x-api-key 返回 401,且不打上游", async () => {
    const res = await app().request("/v1/messages", withHeaders({ "x-api-key": "wrong-token-not-real-000" }));
    expect(res.status).toBe(401);
    expect(up.relayCalls()).toHaveLength(0);
  });

  it("Bearer 优先:Bearer 错时不因 x-api-key 对而放行", async () => {
    const res = await app().request(
      "/v1/messages",
      withHeaders({ authorization: "Bearer wrong-token-not-real-000", "x-api-key": TOKEN }),
    );
    expect(res.status).toBe(401);
  });

  it("其余面与目录只认 Bearer:只带 x-api-key 时 401", async () => {
    for (const path of buildRegistry().paths()) {
      if (buildRegistry().byPath(path)?.acceptsApiKeyHeader === true) continue;
      const res = await app().request(path, withHeaders({ "x-api-key": TOKEN }));
      expect(res.status, path).toBe(401);
    }
    const models = await app().request("/v1/models", { headers: { "x-api-key": TOKEN } });
    expect(models.status).toBe(401);
    expect(up.relayCalls()).toHaveLength(0);
  });
});

describe("Responses 面的体内会话指针", () => {
  it("`previous_response_id` 被用作亲和键 —— 用**真实**面,不是假面", async () => {
    /*
     * 若只有 `chatSurface`(其 `sessionKeyFrom` 恒返回 undefined),relay 里
     * 「体内指针优先于头」**结构上无法执行**,只能用假面测 —— 调用点存在
     * 但输入集为空。这条用真实的 responses 面。断言方式是行为:同一个 `previous_response_id`
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
     * reason 的取值是 `"sticky"`(不是 `"session"` ——
     * 实际集合是 sticky/blob_hint/strategy/all_cooling/empty,见 `select.ts`)。
     * 这条断言正是为了把"两次同一个 Worker"与"两次都恰好排第一"区分开:
     * 没有它,把体内指针读取整个删掉后测试仍会绿(三个 Worker 的策略顺序稳定)。
     */
    expect(second.headers.get("x-zen-gateway-route")).toBe("sticky");
  });
});
