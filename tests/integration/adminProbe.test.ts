import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { Hono } from "hono";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";
import { OverviewSchema, ProbeReportSchema, ProxyListSchema } from "../../src/shared/contract.ts";
import { allSecretValues } from "../../src/server/admin/project.ts";
import { KEY_A, KEY_B, get, makeApp, makeConfig, patch, post } from "./helpers/adminFixture.ts";

/*
 * 管理 API 中会写回配置的探测与订阅：实测出口 IP 写回、订阅列表与刷新。
 */

/* ================================================================== *
 * 探测并写回实测出口 IP
 * ================================================================== */

describe("POST /api/probe 把实测 IP 写回配置", () => {
  let echo: Server;
  let echoPort: number;

  beforeEach(async () => {
    /*
     * 一个假的 IP 回显服务。
     *
     * 不打真实 `api.ipify.org`:那会让这些测试依赖网络,而上游抖动
     * 不该让本地关卡变红。真实链路已在生产上验过(三个节点各拿到
     * 互不相同的公网 IP)。
     *
     * 按请求计数返回**不同**的 IP —— 那是「出口隔离成立」的必要条件,
     * 若回显同一个 IP 就测不到「分组」这件事。
     */
    let n = 0;
    echo = createServer((_req, res) => {
      n += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`198.51.100.${n}`);
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
    echoPort = (echo.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => echo.close(() => r()));
  });

  it("**探测期间用户改配置不会被覆盖** —— 合并前要重读", async () => {
    /*
     * 守的是丢失更新。`probeAll` 约 6 秒，那几秒足够用户在
     * Worker 页改个名并保存。若用探测**开始前**那份快照合并，
     * 探测返回后写回时会把用户的改动凭空覆盖 —— 响应 200、
     * `changed: true`，没有任何症状。
     *
     * 同一文件的订阅刷新与 `batchRunner.#persist` 都显式防了这个并写明了
     * 理由；三处同类路径必须一致（纪律 #4）。
     */
    /*
     * 卡住的 IP 回显服务 —— 让探测停在半路，期间发 PATCH。
     * 这是「6 秒窗口」的可控版本。它同时当代理端口（与本块其余用例同构）。
     */
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = createServer((_req, res) => {
      void gate.then(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("198.51.100.77");
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", () => r()));
    const slowPort = (slow.address() as { port: number }).port;

    const config = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "probe-race-token-not-real" },
      workers: [{ id: "w1", kind: "authenticated", apiKey: "k".repeat(20), proxyId: "p1", name: "原名" }],
      proxies: [
        {
          id: "p1", name: "直连", type: "http", host: "127.0.0.1", port: slowPort,
          source: "manual", direct: true, bridgeable: false, egressIp: null,
        },
      ],
      clash: { enabled: false, bridges: [] },
    });

    try {
      const { app, getConfig } = makeApp(config, {
        probeServices: [{ url: `http://127.0.0.1:${slowPort}/`, extract: (t) => t.trim() }],
      });

      // 探测开始，但卡在回显服务上。
      const probing = app.request("http://127.0.0.1/api/probe", { method: "POST" });
      await new Promise((r) => setTimeout(r, 50));

      // 用户在这几秒里改了名字并保存。
      const { status } = await patch(app, { workers: { update: { w1: { name: "用户改的名字" } } } });
      expect(status).toBe(200);
      expect(getConfig().workers[0]!.name).toBe("用户改的名字");

      // 探测完成并写回。
      release?.();
      const res = await probing;
      expect(res.status).toBe(200);
      const after = getConfig();
      // 这是全部要点：用户的改动必须还在。缺陷版本这里是「原名」。
      expect(after.workers[0]!.name).toBe("用户改的名字");
      // 而且探测结果也真的写进去了 —— 不是靠「什么都没写」通过的。
      expect(after.proxies[0]!.egressIp).toBe("198.51.100.77");
    } finally {
      await new Promise<void>((r) => slow.close(() => r()));
    }
  }, 30_000);

  it("探测成功后 egressIp 落进配置,隔离视图随之成立", async () => {
    /*
     * 这条守的是一个**结构性**缺口:若 `applyProbeResult()` 那个纯函数
     * **零生产调用点**,探测结果就不会写进 `config.proxies[].egressIp`,
     * `isolation` 恒为 `{groups:[], unknownWorkerIds:[全部], isolated:false}` ——
     * 「按实测 IP 分组」这条核心要求没有数据来源。
     */
    /*
     * 代理用 **direct 模式**（socks5 到一个本机端口），不用桥接。
     *
     * 桥接探测要切 Clash selector，那需要一个真实的 Controller —— 而这些
     * 测试不该依赖本机是否开着 Clash。`direct: true` 走 undici/socks 直连，
     * 而「探测 → applyProbeResult → 写回配置 → 隔离视图成立」这条链路
     * 与出口是桥接还是直连**无关**，那正是要测的部分。
     *
     * 出口 IP 由假回显服务给（每次不同），所以隔离分组能真的形成。
     */
    const config = makeConfig({
      workers: [
        { id: "w1", kind: "authenticated", apiKey: KEY_A, proxyId: "p1" },
        { id: "w2", kind: "authenticated", apiKey: KEY_B, proxyId: "p2" },
      ],
      proxies: [
        {
          id: "p1",
          name: "直连一",
          type: "http",
          host: "127.0.0.1",
          port: echoPort,
          source: "manual",
          direct: true,
          bridgeable: false,
          egressIp: null,
        },
        {
          id: "p2",
          name: "直连二",
          type: "http",
          host: "127.0.0.1",
          port: echoPort,
          source: "manual",
          direct: true,
          bridgeable: false,
          egressIp: null,
        },
      ],
      clash: { enabled: false, bridges: [] },
    });

    const { app, getConfig } = makeApp(config, {
      probeServices: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
    });

    const before = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(before.isolation.isolated).toBe(false);
    expect(before.isolation.unknownWorkerIds).toHaveLength(2);

    const res = await app.request("http://127.0.0.1/api/probe", { method: "POST" });
    expect(res.status).toBe(200);
    const probeBody = (await res.json()) as { ok: boolean; changed: boolean; results: unknown[] };
    expect(probeBody.ok).toBe(true);
    expect(probeBody.changed).toBe(true);
    expect(probeBody.results).toHaveLength(2);

    // 写回配置了 —— 这是 `applyProbeResult` 第一次有生产调用点。
    const after = getConfig();
    expect(after.proxies[0]!.egressIp).not.toBeNull();
    expect(after.proxies[1]!.egressIp).not.toBeNull();

    // 而隔离视图因此**第一次能成立**。
    const view = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(view.isolation.unknownWorkerIds).toHaveLength(0);
    expect(view.isolation.isolated).toBe(true);
    expect(view.isolation.groups).toHaveLength(2);
  }, 20_000);

  it("`proxyIds` 只探指定出口并写回；未知 id 整体 404、不探一半", async () => {
    const config = makeConfig({
      workers: [
        { id: "w1", kind: "authenticated", apiKey: KEY_A, proxyId: "p1" },
        { id: "w2", kind: "authenticated", apiKey: KEY_B, proxyId: "p2" },
      ],
      proxies: ["p1", "p2"].map((id) => ({
        id, name: id, type: "http" as const, host: "127.0.0.1", port: echoPort,
        source: "manual" as const, direct: true, bridgeable: false, egressIp: null,
      })),
      clash: { enabled: false, bridges: [] },
    });
    const { app, getConfig } = makeApp(config, {
      probeServices: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
    });

    const missing = await post(app, "/api/probe", { proxyIds: ["p2", "nope"] });
    expect(missing.status).toBe(404);
    expect(getConfig().proxies.every((p) => p.egressIp === null)).toBe(true);

    const res = await post(app, "/api/probe", { proxyIds: ["p2"] });
    expect(res.status).toBe(200);
    expect(ProbeReportSchema.parse(res.body).results.map((r) => r.proxyId)).toEqual(["p2"]);
    expect(getConfig().proxies.map((p) => p.egressIp !== null)).toEqual([false, true]);

    // 空数组与多余字段按契约拒绝。
    expect((await post(app, "/api/probe", { proxyIds: [] })).status).toBe(400);
    expect((await post(app, "/api/probe", { extra: 1 })).status).toBe(400);
  }, 20_000);

  it("没有可用 Worker 时拒绝探测", async () => {
    const { app } = makeApp(
      makeConfig({ workers: [], proxies: [], clash: { enabled: false, bridges: [] } }),
    );
    const res = await app.request("http://127.0.0.1/api/probe", { method: "POST" });
    // 探一个没人用的出口没有诊断价值,而每次探测都要真发网络请求。
    expect(res.status).toBe(422);
  });

  it("探测端点也被回环闸门挡住", async () => {
    const { app, getConfig } = makeApp(makeConfig(), { address: "203.0.113.9" });
    const before = JSON.stringify(getConfig());
    const res = await app.request("http://127.0.0.1/api/probe", { method: "POST" });
    expect(res.status).toBe(403);
    expect(JSON.stringify(getConfig())).toBe(before);
  });

  it("**本机直连的实测 IP 也要落盘并参与隔离分组**", async () => {
    /*
     * `proxyId: null` 的 Worker 走本机网络出口，而**它与某个代理 NAT 到
     * 同一个公网 IP 恰好是「看起来隔离其实没隔离」的形态** ——
     * 所以它必须参与分组。
     *
     * 先前探测会真的跑（结果挂在合成 id `__direct__` 下），但落盘时两个
     * 写入点都只并 `config.proxies`，而那里没有直连这一行 ——
     * 于是每次批测白发一次网络请求，直连 Worker 在隔离报告里永远是「未探测」。
     */
    const config = makeConfig({
      workers: [
        { id: "w-direct", kind: "authenticated", apiKey: KEY_A, proxyId: null },
        { id: "w-proxy", kind: "authenticated", apiKey: KEY_B, proxyId: "p1" },
      ],
      proxies: [
        {
          id: "p1", name: "直连代理", type: "socks5", host: "127.0.0.1", port: echoPort,
          source: "manual", direct: true, bridgeable: false, egressIp: null,
        },
      ],
      clash: { enabled: false, bridges: [] },
    });
    const { app, getConfig } = makeApp(config, {
      probeServices: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
    });

    // 探测前：直连 Worker 的出口是未知的。
    const before = ProxyListSchema.parse((await get(app, "/api/proxies")).body);
    expect(before.isolation.unknownWorkerIds).toContain("w-direct");

    const res = await app.request("http://127.0.0.1/api/probe", { method: "POST" });
    expect(res.status).toBe(200);

    // 落盘了 —— 这是先前被丢掉的那一半。
    expect(getConfig().gateway.directEgressIp).not.toBeNull();

    // 而且它参与了分组：直连 Worker 不再是「未探测」。
    const after = ProxyListSchema.parse((await get(app, "/api/proxies")).body);
    expect(after.isolation.unknownWorkerIds).not.toContain("w-direct");
    const directGroup = after.isolation.groups.find((g) => g.workerIds.includes("w-direct"));
    expect(directGroup).toBeDefined();
  }, 20_000);

  it("**响应过 schema，且不泄漏凭证**", async () => {
    /*
     * 这一条若手工拼装 `ProbeOutcome` 的字段,就成了唯一绕过 schema 与
     * 投影层的管理响应。眼下不泄漏（`reason` 来自
     * `safeErrorMessage`/`describeResolveFailure`，而 `probe.ts` 明确拒绝
     * 把响应正文放进 `reason`），**但那条纪律的全部价值在于
     * "新增端点时漏掉一个字段没有任何症状"** —— 一个在纪律之外的端点
     * 恰好就是那种漏洞会出现的地方。
     *
     * 断言两件事：形状真的过了 `ProbeReportSchema`（多一个字段会被
     * strip 或拒），以及整段响应里没有任何真实凭证。
     */
    const config = makeConfig({
      workers: [{ id: "w1", kind: "authenticated", apiKey: KEY_A, proxyId: "p1" }],
      proxies: [
        {
          id: "p1", name: "直连", type: "socks5", host: "127.0.0.1", port: echoPort,
          password: "proxy-password-not-real", source: "manual",
          direct: true, bridgeable: false, egressIp: null,
        },
      ],
      clash: { enabled: false, bridges: [] },
    });
    const { app } = makeApp(config, {
      probeServices: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
    });

    const res = await app.request("http://127.0.0.1/api/probe", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;

    // 一、形状：直接喂 schema —— 它是响应的唯一契约。
    expect(() => ProbeReportSchema.parse(body)).not.toThrow();

    // 二、凭证：清单从 Config 的实际结构推导，不是手写一份（纪律 #4）。
    const text = JSON.stringify(body);
    for (const secret of allSecretValues(config)) {
      expect(text).not.toContain(secret);
      // 8 位前缀也不行 —— 查整段挡不住部分泄漏。
      expect(text).not.toContain(secret.slice(0, 8));
    }
  }, 20_000);
});

/* ================================================================== *
 * 订阅
 * ================================================================== */

const SUB_TOKEN = "sub-token-not-real-abcdef123456";
const SUB_URL = `https://sub.example.invalid/link?token=${SUB_TOKEN}`;

const SUB_YAML = `proxies:
  - { name: 订阅节点一, type: vless, server: s1.example.invalid, port: 443 }
  - { name: 订阅节点二, type: hysteria2, server: s2.example.invalid, port: 8443 }
`;

function withSubscription(): Config {
  return makeConfig({
    subscriptions: [{ id: "sub1", name: "机场一", url: SUB_URL }],
  });
}

async function refresh(app: Hono, id: string) {
  const res = await app.request(`http://127.0.0.1/api/subscriptions/${id}/refresh`, {
    method: "POST",
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("订阅列表", () => {
  it("**URL 只给脱敏串** —— token 绝不出现在响应里", async () => {
    /*
     * 订阅 URL 的 token 通常带在 query 或 path 里，它本身就是付费凭证。
     * 一个"订阅列表"接口若原样回显 URL，就等于把所有机场的凭证公开在回环上。
     */
    const { app } = makeApp(withSubscription());
    const { status, body } = await get(app, "/api/proxies");
    expect(status).toBe(200);

    const text = JSON.stringify(body);
    expect(text).not.toContain(SUB_TOKEN);
    // 8 位前缀也不行 —— 查整段挡不住部分泄漏。
    expect(text).not.toContain(SUB_TOKEN.slice(0, 8));

    const subs = body.subscriptions as Array<Record<string, unknown>>;
    expect(subs).toHaveLength(1);
    // 但要能认出是哪个订阅。
    expect(String(subs[0]!.urlRedacted)).toContain("sub.example.invalid");
    expect(subs[0]!.name).toBe("机场一");
  });

  it("proxyCount 由服务端算 —— 不受前端筛选影响", async () => {
    const base = withSubscription();
    const config: Config = {
      ...base,
      proxies: [
        ...base.proxies,
        {
          id: "sub_x", name: "订阅来的", type: "vless", host: "s.example.invalid", port: 443,
          enabled: true, source: "subscription", subscriptionId: "sub1",
          direct: false, bridgeable: true, egressIp: null,
        },
      ],
    };
    const { app } = makeApp(config);
    const { body } = await get(app, "/api/proxies");
    const subs = body.subscriptions as Array<Record<string, unknown>>;
    expect(subs[0]!.proxyCount).toBe(1);
  });
});

describe("订阅刷新", () => {
  it("拉取 → 解析 → 并进配置，并写回元信息", async () => {
    const fetchImpl = vi.fn(async () => new Response(SUB_YAML, { status: 200 })) as unknown as typeof fetch;
    const { app, getConfig } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    const { status, body } = await refresh(app, "sub1");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, format: "clash", added: 2, updated: 0, removed: 0 });

    const after = getConfig();
    const imported = after.proxies.filter((p) => p.subscriptionId === "sub1");
    expect(imported).toHaveLength(2);
    // 元信息写回了 —— 界面要显示"最后一次成功拉取"。
    const sub = after.subscriptions[0]!;
    expect(sub.lastFetchedAt).not.toBeNull();
    expect(sub.lastErrorKind).toBeNull();
    expect(sub.lastFormat).toBe("clash");
    expect(sub.lastImportCount).toBe(2);
  });

  it("**幂等**：连刷两次不产生重复，且 id 不变", async () => {
    const fetchImpl = vi.fn(async () => new Response(SUB_YAML, { status: 200 })) as unknown as typeof fetch;
    const { app, getConfig } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    await refresh(app, "sub1");
    const firstIds = getConfig().proxies.map((p) => p.id);
    const second = await refresh(app, "sub1");

    expect(second.body).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(getConfig().proxies.map((p) => p.id)).toEqual(firstIds);
  });

  it("**失败也写回 lastErrorKind** —— 否则连续失败三天看起来一切正常", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const { app, getConfig } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    const { status, body } = await refresh(app, "sub1");
    // 拉取失败不是"请求错误" —— 端点本身工作正常，所以 200 带 ok:false。
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, failureKind: "http_error" });

    const sub = getConfig().subscriptions[0]!;
    expect(sub.lastErrorKind).toBe("http_error");
    // `lastFetchedAt` 的语义是"最后一次**成功**"，失败不该动它。
    expect(sub.lastFetchedAt).toBeNull();
  });

  it("失败的 reason 里不含订阅 token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect failed for ${SUB_URL}`);
    }) as unknown as typeof fetch;
    const { app } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    const { body } = await refresh(app, "sub1");
    const text = JSON.stringify(body);
    expect(text).not.toContain(SUB_TOKEN);
    expect(text).not.toContain(SUB_TOKEN.slice(0, 8));
  });

  it("未知订阅 id 得 404，不是静默成功", async () => {
    const { app } = makeApp(withSubscription());
    const { status, body } = await refresh(app, "nope");
    expect(status).toBe(404);
    expect((body.error as Record<string, unknown>).type).toBe("not_found");
  });

  it("**并发刷新同一订阅得 409** —— 两个并发会互相覆盖配置", async () => {
    /*
     * 成因与批量探测不同：这里两个刷新各读一份旧 config、各算合并、
     * 后写的赢 —— 于是先写的那批新增节点凭空消失。
     */
    const holder: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((r) => {
      holder.release = r;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(SUB_YAML, { status: 200 });
    }) as unknown as typeof fetch;

    const { app } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    const first = refresh(app, "sub1");
    // 第二个在第一个还卡着的时候进来。
    const second = await refresh(app, "sub1");
    expect(second.status).toBe(409);

    holder.release?.();
    const done = await first;
    expect(done.status).toBe(200);

    // 锁释放后还能再刷 —— 不是永久卡住。
    const third = await refresh(app, "sub1");
    expect(third.status).toBe(200);
  });

  it("Clash 未启用时只能桥接的节点以停用状态导入并报出来", async () => {
    /*
     * schema 有一条 superRefine：已启用且只能桥接的代理在 clash.enabled 为
     * false 时是配置矛盾。订阅里绝大多数节点恰好都是只能桥接的，
     * 所以不处理的话这个端点会在 saveConfig 那步炸一长串校验错误。
     */
    const base = makeConfig({
      subscriptions: [{ id: "sub1", name: "机场一", url: SUB_URL }],
      proxies: [],
      workers: [],
      clash: { enabled: false, bridges: [] },
    });
    const fetchImpl = vi.fn(async () => new Response(SUB_YAML, { status: 200 })) as unknown as typeof fetch;
    const { app, getConfig } = makeApp(base, { subscriptionFetch: { fetchImpl } });

    const { status, body } = await refresh(app, "sub1");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, added: 2, disabledNeedBridge: 2 });
    // 关键：写盘成功了（否则这里会是 write_failed）。
    expect(getConfig().proxies.every((p) => !p.enabled)).toBe(true);
  });

  it("**拉取期间用户改了配置，不会被刷新覆盖掉**", async () => {
    /*
     * 变异测试逼出来的：把 `deps.configOf()` 换回拉取**之前**那份 config，
     * 全部测试依然全绿 —— 没有一条覆盖"拉取期间配置变了"这个窗口。
     *
     * 而那个窗口是真实的：多 UA 协商最坏要 40 秒，用户在那几十秒里点一次
     * 保存完全正常。用旧 config 算合并 = 把他的改动静默回滚。
     */
    const holder: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((r) => {
      holder.release = r;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return new Response(SUB_YAML, { status: 200 });
    }) as unknown as typeof fetch;

    const { app, getConfig } = makeApp(withSubscription(), { subscriptionFetch: { fetchImpl } });

    const pending = refresh(app, "sub1");

    // 拉取还卡着 —— 此时用户停用了一个 Worker（一次正常的保存）。
    const patched = await patch(app, { workers: { update: { w1: { enabled: false } } } });
    expect(patched.status).toBe(200);
    expect(getConfig().workers.find((w) => w.id === "w1")!.enabled).toBe(false);

    holder.release?.();
    expect((await pending).status).toBe(200);

    // 刷新做完之后，用户那次改动**仍然在**。
    expect(getConfig().workers.find((w) => w.id === "w1")!.enabled).toBe(false);
    // 而订阅节点也确实导进来了（不是靠"什么都没写"通过的）。
    expect(getConfig().proxies.filter((p) => p.subscriptionId === "sub1")).toHaveLength(2);
  });

  it("刷新端点也在回环闸门之内", async () => {
    /*
     * 新增路由最容易漏掉的就是这一条。装配期断言会在构造时抛，
     * 但这里再从行为上确认一次 —— 管理面不设 Relay Token。
     */
    const { app } = makeApp(withSubscription(), { address: "203.0.113.9" });
    const { status } = await refresh(app, "sub1");
    expect(status).toBe(403);
  });
});
