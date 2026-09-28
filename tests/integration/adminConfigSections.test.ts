import { describe, expect, it } from "vitest";
import { ConfigPatchSchema } from "../../src/shared/contract.ts";
import { applyConfigPatch } from "../../src/server/admin/patch.ts";
import { allSecretValues } from "../../src/server/admin/project.ts";
import { CLASH_SECRET, TOKEN, get, makeApp, makeConfig, patch } from "./helpers/adminFixture.ts";

/*
 * 配置补丁的新增几节：调度、Clash 内核、代理、订阅，以及 Relay Token 轮换和批量建 Worker。
 * 引用约束（被 Worker 绑着的代理不能删）与凭证三态是这里的关键。
 */

const SUB_URL = "https://sub.invalid/link?token=sub-token-must-not-leak";

function withSubscription() {
  return makeConfig({
    subscriptions: [{ id: "s1", name: "订阅一", url: SUB_URL }],
    proxies: [
      ...makeConfig().proxies,
      {
        id: "sp1",
        name: "订阅节点",
        type: "socks5",
        host: "203.0.113.9",
        port: 1080,
        source: "subscription",
        subscriptionId: "s1",
        direct: true,
        bridgeable: false,
      },
    ],
  });
}

describe("routing 补丁", () => {
  it("修改策略、亲和与冷却，并沿用存储 schema 的取值范围", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, {
      routing: { strategy: "mixed", affinityTtlMs: 120_000, cooldown: { rateLimitMs: 30_000 } },
    });
    expect(r).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(getConfig().routing.strategy).toBe("mixed");
    expect(getConfig().routing.affinityTtlMs).toBe(120_000);
    expect(getConfig().routing.cooldown.rateLimitMs).toBe(30_000);
    // 未提到的冷却项不动。
    expect(getConfig().routing.cooldown.authFailMs).toBe(60_000);

    const bad = await patch(app, { routing: { affinityTtlMs: 1 } });
    expect(bad.status).toBe(400);
    expect(getConfig().routing.affinityTtlMs).toBe(120_000);
  });

  it("概览回填表单所需的当前值", async () => {
    const { app } = makeApp(makeConfig());
    const r = await get(app, "/api/overview");
    const body = r.body as { routing: { strategy: string; cooldown: { forbiddenMs: number } }; gateway: Record<string, unknown> };
    expect(body.routing.strategy).toBe("anonymous_first");
    expect(body.routing.cooldown.forbiddenMs).toBe(5_000);
    expect(body.gateway["headersTimeoutMs"]).toBe(60_000);
    expect(body.gateway["bodyTimeoutMs"]).toBe(300_000);
  });
});

describe("Relay Token 轮换", () => {
  it("rotate 由服务端生成新 token，响应不回显", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { gateway: { relayToken: { rotate: true } } });
    expect(r).toEqual({ status: 200, body: { ok: true, changed: true } });
    const token = getConfig().gateway.relayToken;
    expect(token).not.toBe(TOKEN);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("用注入的生成器，证明走的是 rotate 分支而不是三态", () => {
    const result = applyConfigPatch(makeConfig(), { gateway: { relayToken: { rotate: true } } }, () => "rotated-token-for-test-xyz");
    expect(result.ok && result.config.gateway.relayToken).toBe("rotated-token-for-test-xyz");
  });

  it("rotate 只接受 true", () => {
    expect(ConfigPatchSchema.safeParse({ gateway: { relayToken: { rotate: false } } }).success).toBe(false);
  });
});

describe("Clash 补丁", () => {
  it("改内核字段，apiSecret 三态：缺席不动、set 换值", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    await patch(app, { clash: { selectionMode: "manual", bridges: { update: { b1: { priority: 5, localProxyPort: 7999 } } } } });
    const b = getConfig().clash.bridges[0]!;
    expect(getConfig().clash.selectionMode).toBe("manual");
    expect(b.priority).toBe(5);
    expect(b.localProxyPort).toBe(7999);
    expect(b.apiSecret).toBe(CLASH_SECRET);

    await patch(app, { clash: { bridges: { update: { b1: { apiSecret: { set: "new-clash-secret-x" } } } } } });
    expect(getConfig().clash.bridges[0]!.apiSecret).toBe("new-clash-secret-x");
  });

  it("新建内核并在同一请求里设为当前", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, {
      clash: {
        activeBridgeId: "b2",
        bridges: { create: [{ id: "b2", name: "第二个", apiBase: "http://127.0.0.1:9091", localProxyPort: 7891 }] },
      },
    });
    expect(r.status).toBe(200);
    expect(getConfig().clash.activeBridgeId).toBe("b2");
    // 过存储 schema：默认值补齐。
    expect(getConfig().clash.bridges[1]!.selectorGroup).toBe("GLOBAL");
  });

  it("未知内核 id 得 404，不静默成功", async () => {
    const { app } = makeApp(makeConfig());
    expect((await patch(app, { clash: { bridges: { update: { nope: { priority: 1 } } } } })).status).toBe(404);
    expect((await patch(app, { clash: { bridges: { delete: ["nope"] } } })).status).toBe(404);
  });

  it("删除内核时其代理仍被 Worker 引用则拒绝，并点名 Worker", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { clash: { bridges: { delete: ["b1"] } } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("w1");
    expect(getConfig().clash.bridges).toHaveLength(1);
  });

  it("没有引用时连带删除该内核导入的代理并清空 activeBridgeId", async () => {
    const { app, getConfig } = makeApp(makeConfig({ workers: [] }));
    const r = await patch(app, { clash: { bridges: { delete: ["b1"] } } });
    expect(r.status).toBe(200);
    expect(getConfig().clash.bridges).toEqual([]);
    expect(getConfig().proxies).toEqual([]);
    expect(getConfig().clash.activeBridgeId).toBeNull();
  });

  it("字段错误只给路径，不回显 secret", async () => {
    const { app } = makeApp(makeConfig());
    const r = await patch(app, {
      clash: { bridges: { update: { b1: { apiSecret: { set: "bad\nsecret-value-zzz" } } } } },
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain("secret-value-zzz");
  });
});

describe("代理补丁", () => {
  it("启停与改名", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    await patch(app, { proxies: { update: { p2: { name: "改名", enabled: false } } } });
    const p2 = getConfig().proxies.find((p) => p.id === "p2")!;
    expect(p2.name).toBe("改名");
    expect(p2.enabled).toBe(false);
  });

  it("**被 Worker 引用的代理拒绝删除**，并点名 Worker", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { proxies: { delete: ["p1"] } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("w1");
    expect(getConfig().proxies.map((p) => p.id)).toContain("p1");
  });

  it("同一请求里先改绑 Worker 再删代理是合法的", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { workers: { update: { w1: { proxyId: null } } }, proxies: { delete: ["p1"] } });
    expect(r.status).toBe(200);
    expect(getConfig().proxies.map((p) => p.id)).toEqual(["p2"]);
  });

  it("未知代理 id 得 404", async () => {
    const { app } = makeApp(makeConfig());
    expect((await patch(app, { proxies: { delete: ["ghost"] } })).status).toBe(404);
    expect((await patch(app, { proxies: { update: { ghost: { enabled: false } } } })).status).toBe(404);
  });

  it("导入的节点不能改连接信息，配置不变", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const before = getConfig();
    const r = await patch(app, { proxies: { update: { p1: { host: "203.0.113.9" } } } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("不是手工直连代理");
    expect(getConfig()).toBe(before);
  });

  it("只开放直连协议：桥接协议名在 schema 层就拒绝", () => {
    expect(ConfigPatchSchema.safeParse({ proxies: { create: [{ id: "m1", name: "x", type: "vless", host: "h", port: 1 }] } }).success).toBe(false);
    expect(ConfigPatchSchema.safeParse({ proxies: { update: { m1: { type: "anytls" } } } }).success).toBe(false);
  });
});

describe("手工代理的新增与编辑", () => {
  const PASS = "proxy-pass-must-not-leak";

  async function withManual() {
    const fx = makeApp(makeConfig());
    const r = await patch(fx.app, {
      proxies: { create: [{ id: "m1", name: "手工", type: "socks5", host: "203.0.113.9", port: 1080, username: "u", password: PASS }] },
    });
    expect(r.status).toBe(200);
    return fx;
  }

  it("新建的是手工直连代理，未探测，口令不回显", async () => {
    const { app, getConfig } = await withManual();
    expect(getConfig().proxies.find((p) => p.id === "m1")).toMatchObject({
      source: "manual",
      direct: true,
      bridgeable: false,
      egressIp: null,
      username: "u",
      password: PASS,
    });
    const list = await get(app, "/api/proxies");
    const view = (list.body as { proxies: Array<{ id: string; username: string | null; password: { present: boolean } }> }).proxies.find((p) => p.id === "m1")!;
    expect(view.username).toBe("u");
    expect(view.password.present).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain(PASS);
  });

  it("id 重复拒绝整个请求", async () => {
    const { app, getConfig } = await withManual();
    const r = await patch(app, { proxies: { create: [{ id: "p1", name: "撞名", type: "http", host: "h.invalid", port: 8080 }] } });
    expect(r.status).toBe(422);
    expect(getConfig().proxies.filter((p) => p.id === "p1")).toHaveLength(1);
  });

  it("改连接信息清掉实测 IP；只改名不清", async () => {
    const { app, getConfig } = await withManual();
    // 先模拟一次探测写回。
    const probed = structuredClone(getConfig());
    probed.proxies.find((p) => p.id === "m1")!.egressIp = "198.51.100.7";
    const fx = makeApp(probed);

    await patch(fx.app, { proxies: { update: { m1: { name: "改名" } } } });
    expect(fx.getConfig().proxies.find((p) => p.id === "m1")!.egressIp).toBe("198.51.100.7");

    // 值与当前相同不算换出口。
    await patch(fx.app, { proxies: { update: { m1: { port: 1080 } } } });
    expect(fx.getConfig().proxies.find((p) => p.id === "m1")!.egressIp).toBe("198.51.100.7");

    await patch(fx.app, { proxies: { update: { m1: { port: 1081 } } } });
    const m1 = fx.getConfig().proxies.find((p) => p.id === "m1")!;
    expect(m1.port).toBe(1081);
    expect(m1.egressIp).toBeNull();
    // 没提到的凭证不动。
    expect(m1.password).toBe(PASS);
    void app;
  });

  it("换口令也算换出口身份；口令与用户名可以清空", async () => {
    const { app, getConfig } = await withManual();
    const probed = structuredClone(getConfig());
    probed.proxies.find((p) => p.id === "m1")!.egressIp = "198.51.100.7";
    const fx = makeApp(probed);

    await patch(fx.app, { proxies: { update: { m1: { password: { set: "another-pass-xyz" } } } } });
    expect(fx.getConfig().proxies.find((p) => p.id === "m1")).toMatchObject({ password: "another-pass-xyz", egressIp: null });

    await patch(fx.app, { proxies: { update: { m1: { username: "", password: { clear: true } } } } });
    const m1 = fx.getConfig().proxies.find((p) => p.id === "m1")!;
    expect(m1.username).toBeUndefined();
    expect(m1.password).toBeUndefined();
    void app;
  });

  it("非法主机按路径报错，不回显输入", async () => {
    const { app } = await withManual();
    const r = await patch(app, { proxies: { update: { m1: { host: "bad host\r\nX: y" } } } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain("bad host");
  });
});

describe("gateway.port 补丁", () => {
  it("写进配置，概览同时给出实际端口与配置端口", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { gateway: { port: 20555 } });
    expect(r.status).toBe(200);
    expect(getConfig().gateway.port).toBe(20555);
    const o = (await get(app, "/api/overview")).body as { gateway: { port: number; configuredPort: number } };
    expect(o.gateway.configuredPort).toBe(20555);
    // 监听端口不热切换：实际端口仍是进程启动时的那个。
    expect(o.gateway.port).not.toBe(20555);
  });

  it("特权端口与越界值被拒绝", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    expect((await patch(app, { gateway: { port: 80 } })).status).toBe(400);
    expect((await patch(app, { gateway: { port: 70000 } })).status).toBe(400);
    expect(getConfig().gateway.port).toBe(9999);
  });
});

describe("订阅补丁", () => {
  it("新建订阅，URL 不出现在任何响应里", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const r = await patch(app, { subscriptions: { create: [{ id: "s9", name: "新订阅", url: SUB_URL, enabled: true }] } });
    expect(r.status).toBe(200);
    expect(getConfig().subscriptions[0]!.lastFetchedAt).toBeNull();

    const secrets = allSecretValues(getConfig());
    expect(secrets).toContain("sub-token-must-not-leak");
    for (const path of ["/api/overview", "/api/proxies"]) {
      const text = JSON.stringify((await get(app, path)).body);
      for (const s of secrets) expect(text, path).not.toContain(s);
    }
  });

  it("url 走三态：缺席不动，set 换值", async () => {
    const { app, getConfig } = makeApp(withSubscription());
    await patch(app, { subscriptions: { update: { s1: { name: "改名" } } } });
    expect(getConfig().subscriptions[0]!.url).toBe(SUB_URL);
    await patch(app, { subscriptions: { update: { s1: { url: { set: "https://sub.invalid/other" } } } } });
    expect(getConfig().subscriptions[0]!.url).toBe("https://sub.invalid/other");
  });

  it("删除订阅时连带删除其代理；有 Worker 引用时拒绝", async () => {
    const referenced = withSubscription();
    referenced.workers[0]!.proxyId = "sp1";
    const blocked = makeApp(referenced);
    const r = await patch(blocked.app, { subscriptions: { delete: ["s1"] } });
    expect(r.status).toBe(422);
    // 点名 Worker 是显式检查独有的：全量 schema 也会 422，但只给 `workers.0.proxyId`。
    expect(JSON.stringify(r.body)).toContain("w1");
    expect(blocked.getConfig().subscriptions).toHaveLength(1);

    const free = makeApp(withSubscription());
    expect((await patch(free.app, { subscriptions: { delete: ["s1"] } })).status).toBe(200);
    expect(free.getConfig().subscriptions).toEqual([]);
    expect(free.getConfig().proxies.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("批量建 Worker", () => {
  it("一次 PATCH 建 70 个匿名 Worker，且足够快", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const create = Array.from({ length: 70 }, (_, i) => ({
      id: `anon-${i + 1}`,
      name: `匿名 · 节点 ${i + 1}`,
      kind: "anonymous",
      proxyId: i % 2 === 0 ? "p1" : "p2",
    }));
    const started = performance.now();
    const r = await patch(app, { workers: { create } });
    const elapsed = performance.now() - started;
    expect(r.status).toBe(200);
    expect(getConfig().workers).toHaveLength(72);
    // 宽松上界：只防 O(n²) 级退化，不是性能基准。
    expect(elapsed).toBeLessThan(2_000);
  });
});
