import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../../src/server/app.ts";
import { ModelCatalog, catalogIdentityOf } from "../../src/core/models/catalog.ts";
import { ConfigSchema } from "../../src/shared/schema.ts";
import { TOKEN, useSurfaceFixture } from "./helpers/surfaceFixture.ts";

/**
 * 在架目录的集成测试:免费判定与在架目录的交集,以及 `/v1/models` 的缓存。
 *
 * 对着真实假上游跑,因为「转发路径不为每个请求拉目录」「经 /v1/models 填上的
 * 目录立刻对转发面生效」这类性质只在真实装配里才看得见。
 */

const { up, config, relay, app } = useSurfaceFixture();

describe("目录交集(免费判定的 ∩ 在架目录)", () => {
  it("**已下架**的 -free 模型被拒,且不打上游", async () => {
    /*
     * 注入一个已下架 id(如 glm-5-free)后,它应被交集自动剔除。
     *
     * `glm-5-free` 后缀命中,所以只看后缀的免费判定会放行它,再由上游返回
     * 400 `Model is unavailable.` —— 用户看到上游措辞,指不到真实原因。
     * 交集让它在本机就被拒掉,而且**省掉一次上游往返**。
     */
    const cfg = config();
    const catalog = await up.warmCatalog(cfg);
    up.calls = [];

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
    expect(up.relayCalls()).toHaveLength(0);
  });

  it("在架的免费模型照常放行 —— 证明拒绝来自交集", async () => {
    const cfg = config();
    const catalog = await up.warmCatalog(cfg);
    up.calls = [];
    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "nemotron-3-ultra-free", messages: [] }),
    );
    expect(res.status).toBe(200);
    expect(up.relayCalls()).toHaveLength(1);
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
    const catalog = await up.warmCatalog(cfg);
    up.calls = [];
    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "claude-opus-5", messages: [] }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("不在免费集内");
    expect(up.relayCalls()).toHaveLength(0);
  });

  it("转发路径**不为每个请求**拉目录", async () => {
    /*
     * 若在每个转发请求上调 `refreshIfStale`,一次客户端请求就变成两次
     * 上游请求(POST + GET),而拉取失败不填缓存 → 下个请求又发一次 →
     * 稳态永久 ×2。
     *
     * 那正是纪律里"跨请求的状态机必须配集成测试"的又一个实例:
     * 纯单测看不见"一次请求发了几次上游"。
     */
    const cfg = config();
    const a = app(cfg, new ModelCatalog());
    for (let i = 0; i < 5; i += 1) {
      await a.request("/v1/chat/completions", relay({ model: "big-pickle", messages: [] }));
    }
    expect(up.relayCalls()).toHaveLength(5);
    // 关键:一次目录请求都没有(转发路径只读缓存)。
    expect(up.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("判出「已下架」时刷一次目录 —— 上游**新上架**的模型能自愈", async () => {
    /*
     * 没有这条时,删掉这行刷新后全量测试仍全绿。
     *
     * 它收口的是 `catalog.ts` 文件头点名为"更糟的那一侧"的那个:
     * **缓存里没有而上游有** → 网关误拒一个可用模型。与另一侧(缓存里多一个 →
     * 上游 400 → `bad_request` → 不重试不归咎,自限)不同,这一侧**不自愈**,
     * 用户会看到一个在架的免费模型被永久拒绝,直到有人主动访问 `/v1/models`。
     *
     * ## 断言的是**自愈**这个可观察行为,不是"某个方法被调用了"
     *
     * 后者会在重构时假红,而且它不能区分"调用了但没生效"。这里的判据是
     * 第二次请求真的 200。
     */
    const cfg = config({ models: { catalogTtlMs: 60_000 } });
    let now = 1_000;
    const catalog = new ModelCatalog({ clock: () => now });

    // 上游此刻还没有这个模型,预热出一份不含它的目录。
    await catalog.ensure(catalogIdentityOf(cfg), cfg, (c) => up.egress.upstreamDeps(c));
    const a = app(cfg, catalog);

    // 上游**新上架**了它(带 -free 后缀,所以免费依据成立)。
    up.liveIds = [...up.liveIds, "space-bunny-free"];
    // 让缓存过期 —— 刷新只在过期时才发生（新鲜时刻意不刷，见 relay.ts）。
    now += 60_001;
    up.calls = [];

    const first = await a.request(
      "/v1/chat/completions",
      relay({ model: "space-bunny-free", messages: [] }),
    );
    // 第一次仍按旧目录拒绝 —— 那是对的,此刻我们手里只有旧目录。
    expect(first.status).toBe(403);
    expect(((await first.json()) as { error: { message: string } }).error.message).toContain(
      "已不在上游在架目录",
    );

    /*
     * 排空后台刷新。必须过**宏任务** —— 只 await 微任务排不到
     * `#fetchOnce` 的 `.finally` 那一层（`#inFlight.delete` 在那里），
     * 于是"第二次没发请求"的真实原因会变成合流去重还没清理。
     */
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => {
        setTimeout(r, 0);
      });
      if (catalog.cached("keyed")?.ids.has("space-bunny-free") === true) break;
    }

    // 刷新真的发生了,且新目录已进缓存。
    expect(up.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(catalog.cached("keyed")?.ids.has("space-bunny-free")).toBe(true);

    // 自愈:同一个模型的下一次请求放行。
    const second = await a.request(
      "/v1/chat/completions",
      relay({ model: "space-bunny-free", messages: [] }),
    );
    expect(second.status).toBe(200);
  });

  it("目录**新鲜**时判出已下架**不**刷新 —— 否则反复请求坏模型名会放大", async () => {
    /*
     * 上一条的反向钉子。刷新只在过期时才该发生:一个客户端反复请求一个
     * 真的已下架的模型(比如配置里残留的旧 id),不该每次都触发一次上游查询。
     *
     * 没有这条,把 `refreshIfStale` 改成无条件 `ensure` 也不会有测试变红,
     * 而那正是"每请求刷目录"缺陷的变体。
     */
    const cfg = config();
    const catalog = await up.warmCatalog(cfg);
    const a = app(cfg, catalog);
    up.calls = [];

    for (let i = 0; i < 10; i += 1) {
      const res = await a.request("/v1/chat/completions", relay({ model: "glm-5-free", messages: [] }));
      expect(res.status).toBe(403);
    }
    // 目录新鲜 → 一次刷新都没有。
    expect(up.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("**槽位由推导决定,不是硬写** —— 没有可用 Worker 时读的是 keyless 槽", async () => {
    /*
     * 守的是纪律 #4 分叉:读侧若硬写 `cached("keyed")`,
     * 而写侧(retired 那支的刷新)用 `catalogIdentityOf` **推导**槽位。
     *
     * 支撑硬写的注释推错了时序:免费判定是**第 3 步**,选 Worker 是**第 5 步** ——
     * 第 3 步执行时候选链还不存在,所以"候选链里每个 Worker 都有 key"
     * 在那一刻不是可用前提。所有 Worker 都停用时推导出的是 `keyless`。
     *
     * ## 可观察差异
     *
     * 没有可用 Worker + keyless 槽里有一份目录时,请求一个**不在**该目录里的
     * 免费后缀模型:
     *
     * - 硬写 keyed(缺陷):读到 null → 走 `*_unverified` → **放行** → 第 5 步才
     *   503。交集在这个状态下**完全失效**。
     * - 推导 keyless(正确):读到目录 → 交集生效 → 403 retired。
     *
     * 这条同时证明交集在 keyless 身份下也真的工作 —— 而那是首次配置前
     * (还没有任何 Worker)唯一可用的身份。
     */
    const cfg = config({
      workers: [
        {
          id: "w1",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-w1-not-real",
          enabled: false, // 全部停用 → usableTargets 为空 → 身份是 keyless
          proxyId: null,
        },
      ],
    });
    // 预热:身份为 keyless,所以目录进 keyless 槽。
    const catalog = await up.warmCatalog(cfg);
    expect(catalog.cached("keyless")).not.toBeNull();
    expect(catalog.cached("keyed")).toBeNull();

    const res = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "glm-5-free", messages: [] }),
    );

    // 交集生效 → 403 retired,而不是放行后到第 5 步才 503。
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("model_not_allowed");
    expect(body.error.message).toContain("已不在上游在架目录");
  });

  it("**经 /v1/models 填上的目录立刻对转发面生效** —— 不注入 catalog,验真实装配", async () => {
    /*
     * ## 这条补的是一个"注入替换掉了被测的那段"的缺口
     *
     * 本文件其他用例都把 `catalog` 直接注入 `createApp`,而 `app.ts` 里
     * 「转发面与 `/v1/models` **共用同一个**缓存」这条接线,恰好就被那个注入
     * 替换掉了。实测把 models 路由换成 `new ModelCatalog()` 之后全量测试全绿。
     *
     * 同一形态也见于回环测试:注入 `addressOf` 会替换掉正要去读
     * `X-Forwarded-For` 的代码路径。**凡是注入了依赖的测试,都要问"我注入的这个,是不是正好是
     * 我要测的那段"。**
     *
     * ## 不共用时的后果:交集整体静默失效
     *
     * 转发面手里永远是空目录 → `judgeFree` 走 `*_unverified` → 已下架的
     * `xx-free` 重新被放行 → 上游 400 `Model is unavailable`。而同时
     * `/v1/models` 显示的目录是新鲜的 —— 于是症状是"模型列表里有它、点了报
     * 上游错误",恰好是交集要消灭的那个陷阱。没有任何日志、没有任何报错。
     *
     * 所以这条**刻意不注入** catalog,走 `app.ts` 自己建的那一个。
     */
    const cfg = config();
    const a = createApp({ configOf: () => cfg, egress: up.egress, log: () => {} });

    // 先经 /v1/models 把目录填上（这是它唯一的填充路径,因为没有预热）。
    const list = await a.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(list.status).toBe(200);
    expect(up.calls.filter((c) => c.method === "GET")).toHaveLength(1);

    // 若两条路径共用同一个缓存,转发面此刻已经能做交集。
    const res = await a.request(
      "/v1/chat/completions",
      relay({ model: "glm-5-free", messages: [] }),
    );
    expect(res.status, "共用缓存时交集必须已经生效").toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("已不在上游在架目录");
    // 交集在本机拦住,没有多打一次上游。
    expect(up.relayCalls()).toHaveLength(0);
  });

  it("放行但**未经在架核验**时带 `x-zen-gateway-free` 头", async () => {
    /*
     * `judgeFree` 为此造了 `suffix_unverified`/`extra_unverified` 两个 reason,
     * 若全仓没有任何读者,就成了死字段的形态(声明了、被文档说明、
     * 却没有一处读它),只是藏在一个看起来被用到的联合类型分支里。
     *
     * 没有它时,用户遇到上游 400 `Model is unavailable` 无法区分
     * 「目录说它在架但上游拒了」与「我们压根没拿到目录」—— 后者要查出口/网络,
     * 前者要查上游。
     */
    // 空目录（没预热过）→ 放行但未核验。
    const unverified = await app(config(), new ModelCatalog()).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    expect(unverified.status).toBe(200);
    expect(unverified.headers.get("x-zen-gateway-free")).toBe("extra_unverified");

    // 有目录 → 经过核验 → 不带这个头。
    const cfg = config();
    const catalog = await up.warmCatalog(cfg);
    const verified = await app(cfg, catalog).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    expect(verified.status).toBe(200);
    expect(verified.headers.get("x-zen-gateway-free")).toBeNull();
  });

  it("`x-zen-gateway-free` 在**失败路径**上也要有 —— 那才是最需要它的时候", async () => {
    /*
     * 这个头要回答的问题恰好是一次失败:上游返回 400 时,是"目录说它在架但
     * 上游拒了"还是"我们压根没拿到目录"?只在成功路径设置它,等于在唯一需要
     * 它的时候缺席 —— `x-zen-gateway-route` 也有过同样的问题
     * (文档教用户失败时看它,而它只在成功时存在)。
     */
    up.handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "server_error", message: "Model is unavailable." } }));
    };
    const res = await app(config(), new ModelCatalog()).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("x-zen-gateway-free")).toBe("extra_unverified");
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
    expect(up.calls.filter((c) => c.method === "GET")).toHaveLength(1);
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
    up.liveIds = [];
    up.server.close();
    await once(up.server, "close");

    // 缓存仍新鲜 → 不重拉,照常给出旧的。
    const second = await a.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: unknown[] }).data).toHaveLength(2);

    // 重新起一个空服务器让 afterEach 能正常关掉。
    up.server = createServer((_req, res) => res.end("{}"));
    up.server.listen(0, "127.0.0.1");
    await once(up.server, "listening");
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
