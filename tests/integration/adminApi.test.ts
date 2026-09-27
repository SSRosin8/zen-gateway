import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Response as UndiciResponse } from "undici";
import { catalogIdentityOf } from "../../src/core/models/catalog.ts";
import { ProtocolDeclarations } from "../../src/core/models/protocols.ts";
import { DispatcherPool } from "../../src/core/proxy/dispatcher.ts";
import { SelectorLockRegistry } from "../../src/core/proxy/selectorLock.ts";
import { ConfigSchema, CONFIG_VERSION } from "../../src/shared/schema.ts";
import {
  ModelListSchema,
  OverviewSchema,
  ProxyListSchema,
  StatsViewSchema,
} from "../../src/shared/contract.ts";
import { allSecretValues, displayFingerprint } from "../../src/server/admin/project.ts";
import { KEY_A, KEY_B, get, makeApp, makeConfig, post } from "./helpers/adminFixture.ts";

/*
 * 管理 API 的读端点：凭证不出进程、overview、统计、代理 / 模型 / 批测列表。
 *
 * 最要紧的一组断言是**凭证不出进程**：`config.json` 整个文件都是凭证，
 * 而管理面要回答的是「配没配 key」而不是 key 本身。那组测试遍历响应的
 * 全部字符串值，断言真实凭证一个都不出现 —— 而凭证清单从 `Config` 的实际
 * 结构推导（`allSecretValues`），不是测试里手写一份（手写会在 schema
 * 加字段时漏掉，而漏的方向正是泄露）。
 */

/* ================================================================== *
 * 凭证不出进程
 * ================================================================== */

describe("管理 API 绝不回显凭证", () => {
  it("/api/overview 的响应里不含任何真实凭证（整段与前缀都不行）", async () => {
    const config = makeConfig();
    const { app } = makeApp(config);

    const { status, body } = await get(app, "/api/overview");
    expect(status).toBe(200);

    /*
     * 凭证清单从 `Config` 的实际结构推导，**不是**测试里手写一份。
     * 手写的话 schema 加一个凭证字段时那份名单不会更新，而脱节方向是泄露。
     */
    const secrets = allSecretValues(config);
    expect(secrets.length).toBeGreaterThan(0); // 确认真的有东西可泄露

    const serialized = JSON.stringify(body);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
      /*
       * **前缀也要查** —— 这条是变异测试逼出来的。
       *
       * 把投影改成 `fingerprint: worker.apiKey.slice(0,8)`（泄露 key 的前 8 位）
       * 之后，只查整段的版本**依然通过**：`"zen-key-"` 不等于完整 key，
       * 所以 `not.toContain(完整key)` 成立。而一个泄露前缀的指纹是真实缺陷 ——
       * 它把凭证的一部分送进了浏览器，且足以缩小暴力搜索空间。
       *
       * 8 是有意义的长度:指纹本身就是 8 位,所以「响应里出现了真实凭证的
       * 任意 8 位前缀」恰好能抓住「用明文前缀冒充指纹」这个形态。
       */
      expect(serialized).not.toContain(secret.slice(0, 8));
    }
  });

  it("只给「有没有」与 8 位指纹,而指纹能区分等长的不同 key", async () => {
    const { app } = makeApp(makeConfig());
    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    expect(parsed.gateway.relayToken.present).toBe(true);
    expect(parsed.gateway.relayToken.fingerprint).toHaveLength(8);

    /*
     * **用指纹而不是长度**:等长的两个 key 长度相同,于是「我改了没生效」
     * 在界面上不可见 —— 而那恰好是修密码最常见的形态(把打错的换成同长度
     * 的对的)。这条断言钉住「两个等长 key 的展示值不同」。
     */
    const a = displayFingerprint("same-length-key-aaaa");
    const b = displayFingerprint("same-length-key-bbbb");
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("未配置的凭证报 present:false 且指纹为 null", () => {
    expect(displayFingerprint("")).toEqual({ present: false, fingerprint: null });
    // 只有空白也算未配置 —— 与 `isUsable()` 的 `.trim()` 判定一致。
    expect(displayFingerprint("   ")).toEqual({ present: false, fingerprint: null });
  });
});

/* ================================================================== *
 * Overview：配置 + 运行期状态合并
 * ================================================================== */

describe("/api/overview 把配置与运行期状态合在一处", () => {
  it("enabled / inPool / ready 是三个**分开**的事实", async () => {
    const config = makeConfig({
      workers: [
        { id: "on", kind: "authenticated", apiKey: KEY_A, proxyId: null },
        // 匿名 Worker 没有 key 也应进入候选池。
        { id: "nokey", kind: "anonymous", apiKey: "", proxyId: null },
        { id: "off", kind: "authenticated", apiKey: KEY_B, enabled: false, proxyId: null },
      ],
      proxies: [],
      clash: { enabled: false, bridges: [] },
    });
    const { app } = makeApp(config);

    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);
    const byId = new Map(parsed.workers.map((w) => [w.id, w]));

    /*
     * 「启用了但没 key」必须与「已停用」区分开:合成一类的话,用户会看到
     * enabled 为真却发现它从不被选中,而界面上没有任何线索。
     */
    expect(byId.get("nokey")).toMatchObject({ enabled: true, inPool: true, ready: true });
    expect(byId.get("off")).toMatchObject({ enabled: false, inPool: false, ready: false });
    expect(byId.get("on")).toMatchObject({ enabled: true, inPool: true, ready: true });

    // 池计数只算在候选池里的 —— 停用不算，匿名 Worker 即使没 key 也算。
    expect(parsed.pool).toMatchObject({ ready: 2, total: 2, health: "healthy" });
  });

  it("冷却中的 Worker 报 ready:false 并给出剩余时间与失败类别", async () => {
    const config = makeConfig();
    const { app, scheduler } = makeApp(config);

    // 真实地把 w1 打进冷却 —— 不伪造运行期状态。
    scheduler.record(
      { workerId: "w1", failure: "rate_limit", retryAfter: "900", blameWorker: true, status: 429, latencyMs: 5 },
      config,
      Date.now(),
    );

    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);
    const w1 = parsed.workers.find((w) => w.id === "w1")!;

    expect(w1.inPool).toBe(true);
    expect(w1.ready).toBe(false);
    // 上游说了等 900 秒,我们必须尊重它 —— 这个数字要能在界面上看到。
    expect(w1.cooldownRemainingMs).toBeGreaterThan(890_000);
    expect(w1.lastFailure).toBe("rate_limit");
    expect(parsed.pool).toMatchObject({ ready: 1, total: 2, health: "degraded" });
  });

  it("空池报 empty 而不是 healthy", async () => {
    const { app } = makeApp(
      makeConfig({ workers: [], proxies: [], clash: { enabled: false, bridges: [] } }),
    );
    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    // `ready === total` 得到 `0 === 0` 为真 —— 那会让首启第一眼显示「全部健康」。
    expect(parsed.pool).toEqual({ ready: 0, total: 0, health: "empty" });
  });

  it("出口隔离按实测 IP 分组,共用 IP 必须被报出来", async () => {
    const config = makeConfig();
    // 两个代理 NAT 到**同一个**公网 IP —— 「看起来隔离其实没隔离」。
    config.proxies[1]!.egressIp = "198.51.100.1";
    const { app } = makeApp(config);

    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    expect(parsed.isolation.isolated).toBe(false);
    expect(parsed.isolation.sharedGroups).toHaveLength(1);
    expect(parsed.isolation.sharedGroups[0]!.workerIds.sort()).toEqual(["w1", "w2"]);
  });

  it("未探测出 IP 时**不算已隔离**", async () => {
    const config = makeConfig();
    config.proxies[0]!.egressIp = null;
    config.proxies[1]!.egressIp = null;
    const { app } = makeApp(config);

    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    // 「还不知道」与「确认不同」是两件事 —— 混在一起会给出虚假的安全感。
    expect(parsed.isolation.isolated).toBe(false);
    expect(parsed.isolation.unknownWorkerIds.sort()).toEqual(["w1", "w2"]);
    expect(parsed.isolation.sharedGroups).toHaveLength(0);
  });

  it("停用的 Worker 不进隔离报告", async () => {
    const config = makeConfig();
    config.workers[1]!.enabled = false;
    config.proxies[1]!.egressIp = null;
    const { app } = makeApp(config);

    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    /*
     * 一个停用的 Worker 不发流量。把它算进去会让「未知出口」凭空多一个,
     * 于是 `isolated` 永远为 false —— 用户永远看到「未隔离」而实际在用的
     * 那个是隔离的。
     */
    expect(parsed.isolation.unknownWorkerIds).toEqual([]);
    expect(parsed.isolation.isolated).toBe(true);
  });

  it("目录拉不到时 freeCount 为 null,不是 0", async () => {
    const { app } = makeApp(makeConfig());
    const { body } = await get(app, "/api/overview");
    const parsed = OverviewSchema.parse(body);

    // 「还没拿到目录」与「一个免费模型都没有」是两件事,后者才需要排查。
    expect(parsed.catalog.freeCount).toBeNull();
  });
});

/* ================================================================== *
 * 统计
 * ================================================================== */

describe("/api/stats", () => {
  it("默认带 sinceDay,而且它真的传到了聚合函数", async () => {
    const { app, seenSinceDay } = makeApp(makeConfig());
    const { status, body } = await get(app, "/api/stats");

    expect(status).toBe(200);
    const parsed = StatsViewSchema.parse(body);
    expect(parsed.sinceDay).not.toBeNull();
    expect(parsed.requests).toBe(7);

    /*
     * 断言**下游真的收到了**那个日期键 —— 不只是响应里有这个字段。
     * 要求是「管理 API 应当总是传它」,而那是对**调用**的要求。
     */
    expect(seenSinceDay.length).toBeGreaterThan(0);
    for (const d of seenSinceDay) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("days=all 显式关掉时间窗,下游收到 undefined", async () => {
    const { app, seenSinceDay } = makeApp(makeConfig());
    const { body } = await get(app, "/api/stats?days=all");
    expect(StatsViewSchema.parse(body).sinceDay).toBeNull();
    // 显式要全量时才允许不传 —— 那是用户的选择,不是默认行为。
    expect(seenSinceDay.every((d) => d === undefined)).toBe(true);
  });

  it("非法 days 报 400", async () => {
    const { app } = makeApp(makeConfig());
    expect((await get(app, "/api/stats?days=0")).status).toBe(400);
    expect((await get(app, "/api/stats?days=abc")).status).toBe(400);
  });

  it("重置必须带 { confirm: true }：没带体、带错体都不清库", async () => {
    let calls = 0;
    const { app } = makeApp(makeConfig(), { statsReset: () => (calls++, 42) });
    for (const body of [undefined, {}, { confirm: false }, { confirm: true, extra: 1 }, "not json"]) {
      expect((await post(app, "/api/stats/reset", body)).status).toBe(400);
    }
    expect(calls).toBe(0);
    const ok = await post(app, "/api/stats/reset", { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, removed: 42 });
    expect(calls).toBe(1);
  });

  it("重置时统计库不可用返回 500，而不是假装成功", async () => {
    const { app } = makeApp(makeConfig(), { stats: false });
    const { status, body } = await post(app, "/api/stats/reset", { confirm: true });
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain("统计库不可用");
  });

  it("统计库不可用时报错,**不返回全 0**", async () => {
    const { app } = makeApp(makeConfig(), { stats: false });
    const { status, body } = await get(app, "/api/stats");

    /*
     * 返回全 0 会让「库坏了」看起来像「没人用」—— 那正是
     * `storeWriteFailures` 存在要防的同一种误导。
     */
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain("统计库不可用");
  });
});

/* ================================================================== *
 * 代理、模型与批测端点
 * ================================================================== */

describe("/api/proxies", () => {
  it("代理口令换成指纹,且 usedBy 由服务端算好", async () => {
    const config = makeConfig();
    config.proxies[0]!.password = "proxy-password-must-not-leak";
    const { app } = makeApp(config);

    const { status, body } = await get(app, "/api/proxies");
    expect(status).toBe(200);
    const parsed = ProxyListSchema.parse(body);

    // 代理口令是凭证 —— 与 apiKey 同一条规则。
    expect(JSON.stringify(body)).not.toContain("proxy-password-must-not-leak");
    expect(parsed.proxies[0]!.password.present).toBe(true);
    expect(parsed.proxies[0]!.password.fingerprint).toHaveLength(8);

    /*
     * `usedBy` 由服务端算 —— 前端要按它显示「删掉这个代理会影响谁」，
     * 而那个判断若在前端做，就与 `patch.ts` 的引用完整性校验成了两份实现。
     */
    expect(parsed.proxies[0]!.usedBy).toEqual(["w1"]);
    expect(parsed.proxies[1]!.usedBy).toEqual(["w2"]);
  });

  it("resolvable 复用 resolveProxy，措辞与转发失败时一致", async () => {
    const config = makeConfig();
    // 停用一个 —— `resolveProxy` 对 disabled 返回失败。
    config.proxies[0]!.enabled = false;
    const { app } = makeApp(config);

    const parsed = ProxyListSchema.parse((await get(app, "/api/proxies")).body);
    const off = parsed.proxies.find((p) => p.id === "p1")!;

    expect(off.resolvable).toBe(false);
    // 措辞来自 `describeResolveFailure` —— 与转发失败时用户看到的是同一句话。
    expect(off.unresolvableReason).toBeTruthy();
    expect(parsed.proxies.find((p) => p.id === "p2")!.resolvable).toBe(true);
  });
});

describe("/api/models", () => {
  it("目录拿不到时 catalogAvailable 为 false,而不是返回空列表就完事", async () => {
    const { app } = makeApp(makeConfig());
    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);

    /*
     * 「拿不到目录」与「目录里一个模型都没有」的下一步完全不同:
     * 前者查网络/CA，后者查 freeSuffix。只返回空列表会把用户引向错误方向。
     */
    expect(parsed.catalogAvailable).toBe(false);
    expect(parsed.models).toEqual([]);
    // 规则照常给出 —— 那来自配置，与目录无关。
    expect(parsed.rules.freeSuffix).toBe("-free");
  });

  it("把配置中的缺失显式免费项列为 retired，并保留 listed=false", async () => {
    const config = makeConfig({
      models: { extraFreeIds: ["missing-free"], enforceCatalog: true },
    });
    for (const worker of config.workers) worker.proxyId = null;
    const { app, catalog } = makeApp(config);
    const response = new UndiciResponse(
      JSON.stringify({ data: [{ id: "listed-free" }, { id: "paid-model" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const pool = new DispatcherPool({ headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
    await catalog.ensure(catalogIdentityOf(config), config, () => ({
      config,
      dispatchers: pool,
      locks: new SelectorLockRegistry(),
      controllerFor: () => null,
      fetchImpl: async () => response,
    }));

    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);
    expect(parsed.models.find((m) => m.id === "missing-free")).toMatchObject({
      free: false,
      reason: "retired",
      listed: false,
    });
    expect(parsed.models.find((m) => m.id === "listed-free")).toMatchObject({
      free: true,
      listed: true,
    });
    await pool.close();
  });

  /** 预置一份在架目录：两个模型。 */
  async function seedCatalog(config: ReturnType<typeof makeConfig>, catalog: ReturnType<typeof makeApp>["catalog"]) {
    const pool = new DispatcherPool({ headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
    await catalog.ensure(catalogIdentityOf(config), config, () => ({
      config,
      dispatchers: pool,
      locks: new SelectorLockRegistry(),
      controllerFor: () => null,
      fetchImpl: async () =>
        new UndiciResponse(JSON.stringify({ data: [{ id: "a-free" }, { id: "b-free" }] }), { status: 200 }),
    }));
    await pool.close();
  }

  it("协议列：声明来自 models.dev 缓存，实测来自统计库，两者分开给", async () => {
    const config = makeConfig();
    for (const worker of config.workers) worker.proxyId = null;
    const protocols = new ProtocolDeclarations({
      url: "http://127.0.0.1:9/unused",
      fetchImpl: (async () =>
        new UndiciResponse(
          JSON.stringify({ opencode: { npm: "@ai-sdk/openai-compatible", models: { "a-free": { provider: { npm: "@ai-sdk/anthropic" } } } } }),
          { status: 200 },
        )) as never,
    });
    await protocols.refreshIfStale();
    const { app, catalog, seenSinceDay } = makeApp(config, {
      admin: { protocols },
      // 旧库里可能有未知面名：不能漏到契约外。
      modelProtocols: new Map([["a-free", ["chat", "bogus"]]]),
    });
    await seedCatalog(config, catalog);

    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);
    expect(parsed.protocolSource.available).toBe(true);
    expect(parsed.models.find((m) => m.id === "a-free")!.protocol).toEqual({ declared: "messages", measured: ["chat"] });
    expect(parsed.models.find((m) => m.id === "b-free")!.protocol).toEqual({ declared: null, measured: [] });
    // 实测查询带了窗口，不做全表扫。
    expect(parsed.measuredSinceDay).not.toBeNull();
    expect(seenSinceDay).toContain(parsed.measuredSinceDay);
  });

  it("实测协议查询缓存一分钟：连续轮询不重复扫明细", async () => {
    const config = makeConfig();
    for (const worker of config.workers) worker.proxyId = null;
    const { app, catalog, seenSinceDay } = makeApp(config, { modelProtocols: new Map([["a-free", ["chat"]]]) });
    await seedCatalog(config, catalog);
    await get(app, "/api/models");
    const after = seenSinceDay.length;
    await get(app, "/api/models");
    await get(app, "/api/models");
    expect(seenSinceDay.length).toBe(after);
  });

  it("没有声明缓存、没有统计库时如实报不可用，不伪造协议", async () => {
    const config = makeConfig();
    for (const worker of config.workers) worker.proxyId = null;
    const { app, catalog } = makeApp(config, { stats: false });
    await seedCatalog(config, catalog);

    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);
    expect(parsed.protocolSource).toEqual({ available: false, fetchedAt: null });
    expect(parsed.measuredSinceDay).toBeNull();
    for (const m of parsed.models) expect(m.protocol).toEqual({ declared: null, measured: [] });
  });

  it("模型页请求触发声明的后台刷新，但不等它", async () => {
    const config = makeConfig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const protocols = new ProtocolDeclarations({
      fetchImpl: (async () => {
        calls += 1;
        await gate;
        return new UndiciResponse(JSON.stringify({ opencode: { models: { "a-free": {} } } }), { status: 200 });
      }) as never,
    });
    const { app } = makeApp(config, { admin: { protocols } });
    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);
    expect(calls).toBe(1);
    expect(parsed.protocolSource.available).toBe(false);
    release();
    await protocols.refreshIfStale();
    expect(protocols.cached()).not.toBeNull();
  });

  it("关闭目录交集时，缺失显式免费项仍可用而不是误称 retired", async () => {
    const config = makeConfig({
      models: { extraFreeIds: ["missing-free"], enforceCatalog: false },
    });
    for (const worker of config.workers) worker.proxyId = null;
    const { app, catalog } = makeApp(config);
    const response = new UndiciResponse(JSON.stringify({ data: [{ id: "listed-free" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const pool = new DispatcherPool({ headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
    await catalog.ensure(catalogIdentityOf(config), config, () => ({
      config,
      dispatchers: pool,
      locks: new SelectorLockRegistry(),
      controllerFor: () => null,
      fetchImpl: async () => response,
    }));

    const parsed = ModelListSchema.parse((await get(app, "/api/models")).body);
    expect(parsed.models.find((m) => m.id === "missing-free")).toMatchObject({
      free: true,
      reason: "extra",
      listed: false,
    });
    await pool.close();
  });
});

describe("/api/batch-probe", () => {
  it("没有 runner 时报不可用,而不是假装空闲", async () => {
    const { app } = makeApp(makeConfig());
    const { status } = await get(app, "/api/batch-probe");
    expect(status).toBe(500);
  });

  it("非法 action 被拒", async () => {
    const { app } = makeApp(makeConfig());
    const res = await app.request("http://127.0.0.1/api/batch-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "explode" }),
    });
    // 500（无 runner）或 400（非法 action）都可接受 —— 两者都不是「静默成功」。
    expect([400, 500]).toContain(res.status);
  });

  it("两个端点都被回环闸门挡住", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    expect((await app.request("http://127.0.0.1/api/batch-probe")).status).toBe(403);
    expect(
      (
        await app.request("http://127.0.0.1/api/batch-probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "start" }),
        })
      ).status,
    ).toBe(403);
  });

  it("新端点也不例外:/api/proxies 与 /api/models 同样仅本机", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    expect((await app.request("http://127.0.0.1/api/proxies")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/models")).status).toBe(403);
  });
});

/* ================================================================== *
 * 凭证清单自己也要有关卡
 * ================================================================== */

describe("`allSecretValues` 与 schema 的凭证字段不脱节", () => {
  /*
   * `allSecretValues` 是**逐字段手写枚举**（`relayToken` / `w.apiKey` / `b.apiSecret` /
   * `p.password` / 订阅 URL）—— 也就是它自己就是那条纪律要避免的手写名单，
   * 只是搬到了 `src/` 下。
   *
   * 变异验证：同时把 clash secret 从名单里删掉、并让 `clashView`
   * 真的泄漏它的明文前 8 位 → 没有这层时**全绿**。那正是它声称防住的形态
   * （名单脱节 + 同一字段泄漏），而唯一的守卫（上面那条 `allSecretValues`
   * 断言）的输入就是那份名单本身 —— **关卡的判据来自被检查的对象**。
   *
   * 所以这里加一层：`SecretSchema` / `RelayTokenSchema` 的使用点是可枚举的
   * 唯一真相，每个字段名都必须在 `allSecretValues` 的实现里出现。
   */

  const schemaSrc = readFileSync(
    new URL("../../src/shared/schema.ts", import.meta.url),
    "utf8",
  );
  const projectSrc = readFileSync(
    new URL("../../src/server/admin/project.ts", import.meta.url),
    "utf8",
  );

  it("schema 里每个凭证字段都在清单的实现里被读到", () => {
    /*
     * 抓形如 `  password: SecretSchema.optional(),` 的字段名。
     * `RelayTokenSchema` 一并算进来 —— 它也是凭证，只是类型更窄。
     */
    const fields = [
      ...schemaSrc.matchAll(/^\s*(\w+):\s*(?:SecretSchema|RelayTokenSchema)\b/gm),
    ].map((m) => m[1]!);

    /*
     * 关卡自己不能是空的：正则改坏、schema 改写法都会让下面在零个字段上通过。
     * 当前 schema 有 4 个（password / apiSecret / apiKey / relayToken）。
     */
    expect(fields.length).toBeGreaterThanOrEqual(4);

    const missing: string[] = [];
    let checked = 0;
    for (const field of fields) {
      // 判据是「这个字段名出现在 allSecretValues 所在文件里」——
      // 它是那份名单的唯一实现，而名单必须读到每个凭证字段。
      if (!projectSrc.includes(field)) missing.push(field);
      // 算在判定之后（放循环开头的话 `continue` 也能让计数对上而检查没做）。
      checked += 1;
    }

    expect(checked).toBe(fields.length);
    expect(
      missing,
      "这些凭证字段没有进 allSecretValues —— 它们的值会被送进浏览器而无人发现",
    ).toEqual([]);
  });

  it("**真实配置下四类凭证都被收进清单** —— 不是靠正则空转通过的", () => {
    /*
     * 与上一条配对。上面查的是"字段名出现在文件里"（源码级），这条查
     * 运行期：造一份四类凭证都有的配置，断言每一个值都真的在清单里。
     * 少了它，一个 `return []` 的实现也能让上面那条通过。
     */
    const config = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "R".repeat(24) },
      workers: [{ id: "w1", kind: "authenticated", apiKey: "K".repeat(24), proxyId: "p1" }],
      proxies: [
        {
          id: "p1", name: "代理", type: "http", host: "127.0.0.1", port: 1080,
          username: "user", password: "P".repeat(24),
          source: "manual", direct: true, bridgeable: false, egressIp: null,
        },
      ],
      subscriptions: [{ id: "s1", name: "订阅", url: "https://example.com/sub?token=" + "T".repeat(24) }],
      clash: {
        enabled: true,
        selectionMode: "manual",
        activeBridgeId: "b1",
        bridges: [
          {
            id: "b1", name: "内核", apiBase: "http://127.0.0.1:9097",
            apiSecret: "S".repeat(24), localProxyPort: 7897, selectorGroup: "Proxy",
          },
        ],
      },
    });

    const secrets = allSecretValues(config);
    for (const expected of ["R".repeat(24), "K".repeat(24), "P".repeat(24), "S".repeat(24), "T".repeat(24)]) {
      expect(secrets, `清单漏了 ${expected[0]}...`).toContain(expected);
    }
  });
});
