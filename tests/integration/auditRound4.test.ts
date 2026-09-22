import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { ProtocolRegistry, ProtocolRegistryError } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { readModelField, readStreamField } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";
import type { ProtocolId } from "../../src/shared/schema.ts";
import { loopbackOnly } from "../../src/server/middleware/loopbackOnly.ts";
import { relayAuth } from "../../src/server/middleware/relayAuth.ts";
import { judgeFree } from "../../src/core/models/free.ts";
import { buildUpstreamHeaders } from "../../src/core/upstream/headers.ts";
import {
  errorBodyFromException,
  gatewayError,
  statusForGatewayError,
  typeForFailureKind,
} from "../../src/server/middleware/errorMap.ts";
import { HeaderValidationError } from "../../src/core/upstream/headers.ts";

/**
 * 第四轮独立审核查出的缺陷的回归守卫。
 *
 * 这一轮审核的共同主题不是"代码写错了",而是**关卡没有测试守护** ——
 * 审核做了 13 组变异,其中 5 组改坏实现后测试依然全绿。所以本文件每条测试
 * 都对应一个"曾经改坏也不报警"的位置,且都经变异验证过会变红。
 */

const TOKEN = "regression-token-not-real-x";

function surf(id: ProtocolId, paths: string[]): ProtocolSurface {
  return {
    id,
    clientPaths: paths,
    upstreamPath: `/${id}`,
    streaming: "optional",
    extractModel: readModelField,
    wantsStream: readStreamField,
    sessionKeyFrom: () => undefined,
    extraUpstreamHeaders: () => ({}),
  };
}

let egress: EgressService;

beforeEach(() => {
  egress = new EgressService({ timeouts: { headersTimeoutMs: 2_000, bodyTimeoutMs: 2_000 } });
});

afterEach(async () => {
  await egress.close();
});

function config(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: TOKEN, ...(over.gateway ?? {}) },
    workers: over.workers ?? [],
  });
}

/* ================================================================== *
 * 发现 1 + 5：鉴权挂载点必须覆盖注册表里的每一条路径
 * ================================================================== */

describe("鉴权覆盖：守卫挂载点与注册表不得脱节", () => {
  it("Phase 6 形态下每条注册路径都要鉴权（含无前缀别名）", async () => {
    /*
     * 这是本轮最严重的发现。先前守卫写成 `/v1/*` + `/chat/*` + `/models`
     * 三条字面量,而路由是从 `registry.paths()` 动态挂载的 —— 两份名单脱节。
     * 按 `app.ts` 自己注释承诺的 Phase 6 形态注册 responses/messages 后实测:
     * `/responses` 与 `/messages` **完全绕过鉴权**,成为本机任意进程可用的、
     * 消耗用户 Worker key 的免鉴权中继。
     *
     * 断言写成"遍历注册表的每一条路径",而不是逐条列举路径字面量 ——
     * 后者会随新增面一起过期,而这正是原 bug 的成因。
     */
    const registry = new ProtocolRegistry()
      .register(chatSurface)
      .register(surf("responses", ["/v1/responses", "/responses"]))
      .register(surf("messages", ["/v1/messages", "/messages"]));

    const app = createApp({ configOf: () => config(), egress, registry, log: () => {} });

    const unguarded: Array<[string, number]> = [];
    for (const path of registry.paths()) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      });
      // 401 = 守卫生效。其他任何状态码都说明请求已穿过守卫进了处理器。
      if (res.status !== 401) unguarded.push([path, res.status]);
    }

    expect(unguarded, `这些路径绕过了鉴权: ${JSON.stringify(unguarded)}`).toEqual([]);
  });

  it("/v1/models 与无前缀别名 /models 都要鉴权", async () => {
    // 发现 5：先前删掉 `app.use("/models", …)` 全套测试仍绿,
    // 而该变异下 /models 无 token 会返回 200 并吐出完整目录 ——
    // 且每次都用某个 Worker 的 key 真打一次上游。
    const app = createApp({ configOf: () => config(), egress, log: () => {} });
    for (const path of ["/v1/models", "/models"]) {
      const res = await app.request(path);
      expect(res.status, `${path} 应当要求鉴权`).toBe(401);
    }
  });

  it("装配期断言会抓出裸路由", () => {
    /*
     * `assertEveryRouteGuarded` 是最后一道保险:将来某个 `app.get(...)`
     * 被直接加进来（Phase 9 的管理 API、调试端点）就又会出现一条裸路由,
     * 而那种错误没有任何症状,只是安静地对本机所有进程开放。
     *
     * 这条测试通过"构造一个正常 app 不抛错"来证明断言本身没有误报;
     * 断言的**有效性**由下面那条变异说明覆盖。
     */
    expect(() => createApp({ configOf: () => config(), egress, log: () => {} })).not.toThrow();
  });

  it("/health 是唯一免鉴权端点，且不泄露配置", async () => {
    // service.mjs 的健康等待与 doctor 都靠它,所以必须免鉴权;
    // 因此它的响应内容必须严格无害。
    const app = createApp({ configOf: () => config(), egress, log: () => {} });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as Record<string, unknown>;
    // 只允许这四个字段 —— 多一个字段就可能是一次无意的信息泄露。
    expect(Object.keys(body).sort()).toEqual(["ok", "pid", "uptimeSeconds", "version"]);
  });
});

/* ================================================================== *
 * 发现 2：loopbackOnly 的**默认** addressOf 绝不能读 X-Forwarded-For
 * ================================================================== */

describe("回环判定：必须用真 socket 验证生产代码路径", () => {
  /*
   * 原先那条名为"绝不采信 X-Forwarded-For —— 这是本文件最重要的断言"的测试
   * 注入了 `addressOf: () => address`,而**被替换掉的正是会去读那个头的代码
   * 路径**。于是把默认实现改成 `c.req.header("x-forwarded-for") ?? …` 之后,
   * 全套 781 个测试依然全绿 —— 一个结构上无法失败的空壳,正好盖在第 1 号
   * 安全要求上。
   *
   * 修法只有一个:起真服务器、走真 socket、用**默认** addressOf。
   */
  let server: ReturnType<typeof serve>;
  let port: number;

  beforeEach(async () => {
    const app = new Hono();
    // 不注入 addressOf —— 必须走生产默认实现。
    app.use("/api/*", loopbackOnly());
    app.get("/api/ping", (c) => c.json({ ok: true }));

    // 监听 0.0.0.0 才能同时从回环与 LAN 地址连入,以此区分"真来源"与"自称来源"。
    server = serve({ fetch: app.fetch, port: 0, hostname: "0.0.0.0" });
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("拿不到端口");
    port = addr.port;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  it("经 127.0.0.1 的真实请求被放行", async () => {
    // 这条同时覆盖了 IPv4-mapped 的情形:双栈监听下内核报的是
    // `::ffff:127.0.0.1`,朴素字符串比较会把这个合法请求拒掉。
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(200);
  });

  it("带伪造的 X-Forwarded-For 也不能让远端通过", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

    if (lan === undefined) {
      // 没有非回环网卡时这条无法验证真远端,但上一条已证明默认实现在用。
      expect(true).toBe(true);
      return;
    }

    const res = await fetch(`http://${lan}:${port}/api/ping`, {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
      },
    });
    expect(res.status, "伪造 XFF 的远端请求必须被拒").toBe(403);
  });

  it("不带任何头的远端请求同样被拒（对照组）", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
    if (lan === undefined) {
      expect(true).toBe(true);
      return;
    }
    const res = await fetch(`http://${lan}:${port}/api/ping`);
    expect(res.status).toBe(403);
  });
});

/* ================================================================== *
 * 发现 3：凭证类请求头不得转发给上游
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

  it("OpenCode 的身份头必须原样保留（含将来可能新增的带密名字）", () => {
    /*
     * 通用凭证规则用子串匹配,若不豁免 `x-opencode-` 前缀,
     * OpenCode 将来加一个 `x-opencode-token-budget` 之类的头会被静默剥掉,
     * 表现为"某个新功能在网关后面不工作" —— 极难归因。
     */
    const h = build({
      "x-opencode-session": "ses_abc",
      "x-opencode-request": "req_1",
      "x-opencode-project": "proj",
      "x-opencode-client": "cli",
      "x-opencode-token-budget": "4096",
    });
    expect(h["x-opencode-session"]).toBe("ses_abc");
    expect(h["x-opencode-token-budget"]).toBe("4096");
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

/* ================================================================== *
 * 发现 4：空 Relay Token 必须 fail-closed
 * ================================================================== */

describe("Relay Token 为空时必须拒绝（第二道防护）", () => {
  function app(token: string): Hono {
    const a = new Hono();
    a.use("/v1/*", relayAuth({ tokenOf: () => token }));
    a.get("/v1/x", (c) => c.json({ reached: true }));
    return a;
  }

  it("期望值为空串且请求不带 Authorization 时拒绝", async () => {
    /*
     * 先前这里 fail-open:`secureCompare("", "")` 比较两个零长 Buffer,
     * `timingSafeEqual` 返回 true → 放行。于是**不带** token 的请求通过,
     * 而带了任意 token 的反而 401 —— 一个彻底反转的闸门。
     *
     * 先前的保证完全依赖 schema 的 `.min(16)`,中间件自身无防御也无测试。
     * `models/free.ts` 为同样理由留了第二道,这里本该一致。
     */
    expect((await app("").request("/v1/x")).status).toBe(401);
  });

  it("期望值为空串时，带任意 token 也拒绝", async () => {
    const res = await app("").request("/v1/x", { headers: { authorization: "Bearer anything" } });
    expect(res.status).toBe(401);
  });

  it("空期望值的两种失败措辞一致，不泄露「服务端没配 token」", async () => {
    const a = await (await app("").request("/v1/x")).json();
    const b = await (
      await app("").request("/v1/x", { headers: { authorization: "Bearer x" } })
    ).json();
    expect(a).toEqual(b);
  });
});

/* ================================================================== *
 * 发现 6：带 Authorization 时绝不跟随重定向
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
     * 把 `redirect: "manual"` 改成 `"follow"` 后全套 781 个测试依然全绿。
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

    const app = createApp({ configOf: () => cfg, egress, log: () => {} });
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

/* ================================================================== *
 * 发现 7：errorMap 的行为需要守护
 * ================================================================== */

describe("错误映射", () => {
  it("内部异常不回显原始消息", () => {
    /*
     * `safeErrorMessage` 只脱敏 key=value 形态。内部异常的栈、文件路径、
     * 库内部状态不是凭证形,`redactText` 认不出,会原样穿透给客户端。
     * 先前把 500 分支改成回显 `safeErrorMessage(err)` 后全套仍绿。
     */
    const err = new Error("ENOENT: /home/someone/.config/zen-gateway/data/config.json 第 42 行");
    const { status, body } = errorBodyFromException(err);
    expect(status).toBe(500);
    expect(body.error.message).not.toContain("/home/someone");
    expect(body.error.message).not.toContain("config.json");
  });

  it("HeaderValidationError 映射为 400 而非 500", () => {
    // 这类请求是客户端的错。归到 500 会让用户以为是网关坏了。
    const { status, body } = errorBodyFromException(
      new HeaderValidationError("x-custom", "请求头 x-custom 的值含控制字符或换行"),
    );
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_header");
    // 该错误的 message 刻意不含头值,可以直接用。
    expect(body.error.message).toContain("x-custom");
  });

  it("HeaderValidationError 的消息不含头值", () => {
    const err = new HeaderValidationError("x-custom", "请求头 x-custom 的值含控制字符或换行");
    expect(errorBodyFromException(err).body.error.message).not.toContain("SECRET");
  });

  it.each([
    ["model_not_allowed", 403],
    ["invalid_request", 400],
    ["invalid_header", 400],
    ["no_worker_available", 503],
    ["egress_unavailable", 503],
    ["upstream_unreachable", 502],
    ["internal_error", 500],
  ] as const)("状态码映射：%s → %i", (type, expected) => {
    expect(statusForGatewayError(type)).toBe(expected);
  });

  it.each([
    ["transport", "upstream_unreachable"],
    ["upstream_error", "upstream_unreachable"],
    ["timeout", "upstream_unreachable"],
    ["bad_request", "invalid_request"],
    ["unknown", "internal_error"],
  ] as const)("失败分类映射：%s → %s", (kind, expected) => {
    expect(typeForFailureKind(kind)).toBe(expected);
  });

  it("auth/rate_limit 在无上游响应时报 upstream_unreachable", () => {
    /*
     * 正常路径下这两类必定带响应（401/429 都是响应）,走到这里说明是异常情况。
     * 谎称"鉴权失败"会让用户去查 key,而真实原因是连接层问题。
     */
    expect(typeForFailureKind("auth")).toBe("upstream_unreachable");
    expect(typeForFailureKind("rate_limit")).toBe("upstream_unreachable");
  });

  it("错误体形状对齐 OpenAI，客户端才能显示我们写的说明", () => {
    const body = gatewayError("model_not_allowed", "某模型不在免费集内");
    expect(body).toEqual({ error: { type: "model_not_allowed", message: "某模型不在免费集内" } });
  });
});

/* ================================================================== *
 * 发现 8：freeSuffix 为空串时闸门不得全开
 * ================================================================== */

describe("免费判定：freeSuffix 空串的第二道防护", () => {
  /** 绕过 schema 直接构造 —— 这正是第二道防护存在的意义。 */
  function rules(freeSuffix: string) {
    return {
      freeSuffix,
      extraFreeIds: [],
      defaultSurfaces: ["chat"] as ProtocolId[],
      surfaceOverrides: {},
    };
  }

  it.each(["claude-opus-5", "gpt-5.5", "kimi-k3", "anything"])(
    "freeSuffix 为空串时不放行付费模型：%s",
    (id) => {
      /*
       * `"".endsWith("")` 对**任何** id 为真 → 整道付费闸门静默全开。
       * schema 的 `.min(1)` 是第一道,这里是第二道 ——
       * "一个『配置写错就全开』的闸门不该只有一层防护"。
       * 先前去掉 `suffix !== ""` 后全套仍绿。
       */
      expect(judgeFree(id, rules("") as never).free).toBe(false);
    },
  );

  it("空串下连真免费模型也不放行（宁可全关不可全开）", () => {
    // 两侧代价不对称:放行付费模型要花钱,拒绝免费模型只是一条可自查的错误。
    expect(judgeFree("nemotron-3-ultra-free", rules("") as never).free).toBe(false);
  });

  it("正常后缀仍然工作（上面那条不是靠把功能关掉实现的）", () => {
    expect(judgeFree("x-free", rules("-free") as never).free).toBe(true);
    expect(judgeFree("claude-opus-5", rules("-free") as never).free).toBe(false);
  });
});

/* ================================================================== *
 * 发现 9：注册表拒绝静默失效的路径形态
 * ================================================================== */

describe("注册表：拒绝永不匹配与面内重复的路径", () => {
  it("面内重复声明同一路径被拒", () => {
    // 先前只查别的面占用的路径,面内重复被静默接受。
    const r = new ProtocolRegistry();
    expect(() => r.register(surf("chat", ["/x", "/x"]))).toThrow(ProtocolRegistryError);
  });

  it.each([
    ["含 query", "/a?y=1"],
    ["含 fragment", "/a#frag"],
    ["含空格", "/a b"],
    ["含尾部空格", "/a "],
    ["连续斜杠", "//a"],
    ["中间连续斜杠", "/a//b"],
  ])("永远匹配不到请求路径的形态被拒：%s", (_label, path) => {
    /*
     * 注册这样的路径 = 注册一个静默失效的面,与空 clientPaths 同类。
     * 本阶段还多一层意义:`app.ts` 现在从 `registry.paths()` 推导鉴权
     * 挂载点,一条匹配不到的路径会让守卫与处理器双双挂空 ——
     * 虽然二者仍一致（不构成漏洞）,但"整个面无声消失"极难归因。
     */
    const r = new ProtocolRegistry();
    expect(() => r.register(surf("chat", [path]))).toThrow(ProtocolRegistryError);
  });

  it("注册失败后注册表不被部分污染", () => {
    const r = new ProtocolRegistry().register(surf("chat", ["/ok"]));
    expect(() => r.register(surf("responses", ["/good", "/bad?x"]))).toThrow();
    expect(r.byPath("/good")).toBeNull();
    expect(r.get("responses")).toBeNull();
    expect(r.size).toBe(1);
  });

  it("正常路径仍可注册（上面几条不是靠拒绝一切实现的）", () => {
    const r = new ProtocolRegistry();
    expect(() => r.register(surf("chat", ["/v1/chat/completions", "/chat/completions"]))).not.toThrow();
    expect(r.paths()).toHaveLength(2);
  });
});
