import { afterEach, describe, expect, it } from "vitest";
import { ClashDiscoverResponseSchema, ClashImportResponseSchema } from "../../src/shared/contract.ts";
import { bridgeIdFor, isLocalControllerUrl, mergeControllerImport, proxyIdFor } from "../../src/core/proxy/clash/setupImport.ts";
import { makeApp, makeConfig, post } from "./helpers/adminFixture.ts";
import { startFakeClash, type FakeClash } from "./helpers/fakeClash.ts";

/*
 * `/api/clash/discover` 与 `/api/clash/import`：与 `npm run setup` 共用 `setupImport.ts`。
 * 假 Controller 在回环随机端口上，显式传 apiBase，不依赖白名单端口上碰巧有什么。
 */

let fake: FakeClash | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const EMPTY = { workers: [], proxies: [], clash: { enabled: false, bridges: [] } };

describe("Controller 地址只接受本机回环", () => {
  it.each([
    "http://203.0.113.9:9090",
    "https://127.0.0.1:9090",
    "http://user:pw@127.0.0.1:9090",
    "http://127.0.0.1:9090/?x=1",
    "http://proxy.invalid:9090",
  ])("拒绝 %s", (value) => {
    expect(isLocalControllerUrl(value)).toBe(false);
  });

  it.each(["http://127.0.0.1:9090", "http://[::1]:9090", "http://localhost:9090", "http://127.8.9.1:9090"])(
    "接受 %s",
    (value) => {
      expect(isLocalControllerUrl(value)).toBe(true);
    },
  );

  it("**远端地址在联系之前就被拒** —— secret 不会被发出去", async () => {
    fake = await startFakeClash();
    const { app } = makeApp(makeConfig(EMPTY));
    // 用本机网卡以外、明显不可达的地址：若守卫失效，请求会被 offlineGuard 当场拦下而不是 400。
    const remote = { apiBase: "http://203.0.113.9:9090", secret: "s" };
    for (const [path, body] of [
      ["/api/clash/discover", remote],
      ["/api/clash/import", { ...remote, dryRun: true }],
    ] as const) {
      const r = await post(app, path, body);
      expect(r.status, path).toBe(400);
      expect(r.text).toContain("apiBase");
    }
  });
});

describe("发现", () => {
  it("报告版本、模式、混合端口、分组与节点数", async () => {
    fake = await startFakeClash({ mixedPort: 24680 });
    const { app } = makeApp(makeConfig(EMPTY));
    const r = await post(app, "/api/clash/discover", { apiBase: fake.apiBase });
    expect(r.status).toBe(200);
    const body = ClashDiscoverResponseSchema.parse(r.body);
    expect(body.controllers).toEqual([
      expect.objectContaining({ apiBase: fake.apiBase, status: "ok", mixedPort: 24680, selectorGroup: "Proxy", nodeCount: 3, mode: "rule" }),
    ]);
  });

  it("要 secret 时报 auth_required，而不是 unreachable", async () => {
    fake = await startFakeClash({ secret: "clash-secret-we-do-not-know" });
    const { app } = makeApp(makeConfig(EMPTY));
    const r = await post(app, "/api/clash/discover", { apiBase: fake.apiBase });
    expect(ClashDiscoverResponseSchema.parse(r.body).controllers[0]!.status).toBe("auth_required");
  });

  it("会试已配置内核的 secret，且响应不回显它", async () => {
    const secret = "configured-secret-must-not-leak";
    fake = await startFakeClash({ secret });
    const config = makeConfig();
    config.clash.bridges[0]!.apiSecret = secret;
    const { app } = makeApp(config);
    const r = await post(app, "/api/clash/discover", { apiBase: fake.apiBase });
    expect(ClashDiscoverResponseSchema.parse(r.body).controllers[0]!.status).toBe("ok");
    expect(r.text).not.toContain(secret);
  });

  it("没人监听时报 unreachable", async () => {
    const { app } = makeApp(makeConfig(EMPTY));
    const r = await post(app, "/api/clash/discover", { apiBase: "http://127.0.0.1:1" });
    expect(ClashDiscoverResponseSchema.parse(r.body).controllers[0]!.status).toBe("unreachable");
  });

  it("请求体是 strict：拼错字段得 400", async () => {
    const { app } = makeApp(makeConfig(EMPTY));
    expect((await post(app, "/api/clash/discover", { apiBse: "http://127.0.0.1:9090" })).status).toBe(400);
  });
});

describe("导入", () => {
  it("**dryRun 不写配置**，但给出与真导入相同的摘要", async () => {
    fake = await startFakeClash();
    const applied: unknown[] = [];
    const { app, getConfig } = makeApp(makeConfig(EMPTY), { onApply: (c) => applied.push(c) });
    const before = getConfig();

    const dry = await post(app, "/api/clash/import", { apiBase: fake.apiBase, dryRun: true });
    expect(dry.status).toBe(200);
    expect(applied).toHaveLength(0);
    expect(getConfig()).toBe(before);

    const real = await post(app, "/api/clash/import", { apiBase: fake.apiBase, dryRun: false });
    expect(applied).toHaveLength(1);
    const d = ClashImportResponseSchema.parse(dry.body);
    const w = ClashImportResponseSchema.parse(real.body);
    expect(d.dryRun).toBe(true);
    expect(w.dryRun).toBe(false);
    expect(d.summary).toEqual(w.summary);
    expect(w.summary).toMatchObject({ bridgesAdded: 1, proxiesAdded: 3, selectorGroup: "Proxy", mixedPort: 7897 });
  });

  it("真导入立即生效：内核、代理与 activeBridgeId 写进配置，不创建 Worker", async () => {
    fake = await startFakeClash({ mixedPort: 24680 });
    const { app, getConfig } = makeApp(makeConfig(EMPTY));
    await post(app, "/api/clash/import", { apiBase: fake.apiBase, dryRun: false });
    const c = getConfig();
    const bridgeId = bridgeIdFor(fake.apiBase);
    expect(c.clash.enabled).toBe(true);
    expect(c.clash.activeBridgeId).toBe(bridgeId);
    expect(c.clash.bridges[0]).toMatchObject({ id: bridgeId, localProxyPort: 24680, selectorGroup: "Proxy" });
    expect(c.proxies.map((p) => p.id).sort()).toEqual(["节点 A", "节点 B", "节点 C"].map(proxyIdFor).sort());
    expect(c.workers).toEqual([]);
  });

  it("重复导入是幂等的，且保留用户停用的内核", async () => {
    fake = await startFakeClash();
    const { app, getConfig } = makeApp(makeConfig(EMPTY));
    await post(app, "/api/clash/import", { apiBase: fake.apiBase, dryRun: false });
    const merged = mergeControllerImport(getConfig(), []);
    expect(merged.ok).toBe(true);

    const disabled = structuredClone(getConfig());
    disabled.clash.bridges[0]!.enabled = false;
    disabled.clash.activeBridgeId = null;
    disabled.proxies.forEach((p) => (p.enabled = false));
    const again = makeApp(disabled);
    const r = await post(again.app, "/api/clash/import", { apiBase: fake.apiBase, dryRun: false });
    const body = ClashImportResponseSchema.parse(r.body);
    expect(body.summary).toMatchObject({ bridgesAdded: 0, bridgesUpdated: 1, proxiesAdded: 0, proxiesUpdated: 3 });
    expect(again.getConfig().clash.bridges[0]!.enabled).toBe(false);
    expect(again.getConfig().clash.activeBridgeId).toBeNull();
    expect(body.summary.warnings.join()).toContain("停用");
  });

  it("secret 错误得 401 auth_required，不回显 secret", async () => {
    fake = await startFakeClash({ secret: "the-right-secret-zz" });
    const { app, getConfig } = makeApp(makeConfig(EMPTY));
    const before = getConfig();
    const r = await post(app, "/api/clash/import", { apiBase: fake.apiBase, secret: "wrong-secret-value-yy", dryRun: false });
    expect(r.status).toBe(401);
    expect((r.body as { error: { type: string } }).error.type).toBe("auth_required");
    expect(r.text).not.toContain("wrong-secret-value-yy");
    expect(getConfig()).toBe(before);
  });

  it("导入后的 secret 不出现在任何视图里", async () => {
    const secret = "imported-secret-must-not-leak";
    fake = await startFakeClash({ secret });
    const { app } = makeApp(makeConfig(EMPTY));
    const r = await post(app, "/api/clash/import", { apiBase: fake.apiBase, secret, dryRun: false });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(secret);
    for (const path of ["/api/overview", "/api/proxies"]) {
      const res = await app.request(`http://127.0.0.1${path}`);
      expect(await res.text(), path).not.toContain(secret);
    }
  });
});
