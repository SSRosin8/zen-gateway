import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ModelCatalog } from "../../src/core/models/catalog.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";
import { ModelListSchema, OverviewSchema, ProxyListSchema, StatsViewSchema } from "../../src/shared/contract.ts";
import { applyConfigPatch } from "../../src/server/admin/patch.ts";
import { allSecretValues, displayFingerprint } from "../../src/server/admin/project.ts";

/*
 * 管理 API（Phase 9 批次 1）。
 *
 * 最要紧的一组断言是**凭证不出进程**：`config.json` 整个文件都是凭证，
 * 而管理面要回答的是「配没配 key」而不是 key 本身。那组测试遍历响应的
 * 全部字符串值，断言真实凭证一个都不出现 —— 而凭证清单从 `Config` 的实际
 * 结构推导（`allSecretValues`），不是测试里手写一份（手写会在 schema
 * 加字段时漏掉，而漏的方向正是泄露）。
 */

const TOKEN = "admin-test-relay-token-not-real";
const KEY_A = "zen-key-AAAA-must-not-leak";
const KEY_B = "zen-key-BBBB-must-not-leak";
const CLASH_SECRET = "clash-secret-must-not-leak";

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: TOKEN, port: 9999 },
    workers: [
      { id: "w1", kind: "authenticated", apiKey: KEY_A, proxyId: "p1" },
      { id: "w2", kind: "authenticated", apiKey: KEY_B, proxyId: "p2" },
    ],
    proxies: [
      {
        id: "p1",
        name: "节点一",
        type: "anytls",
        host: "127.0.0.1",
        port: 7897,
        source: "controller",
        bridgeId: "b1",
        clashNodeName: "节点一",
        direct: false,
        bridgeable: true,
        egressIp: "198.51.100.1",
      },
      {
        id: "p2",
        name: "节点二",
        type: "anytls",
        host: "127.0.0.1",
        port: 7897,
        source: "controller",
        bridgeId: "b1",
        clashNodeName: "节点二",
        direct: false,
        bridgeable: true,
        egressIp: "198.51.100.2",
      },
    ],
    clash: {
      enabled: true,
      activeBridgeId: "b1",
      bridges: [
        {
          id: "b1",
          name: "verge",
          apiBase: "http://127.0.0.1:9097",
          apiSecret: CLASH_SECRET,
          localProxyPort: 7897,
          selectorGroup: "Proxy",
        },
      ],
    },
    ...overrides,
  });
}

/** 一个最小的 app，带真实 scheduler（运行期状态要真的来自它）。 */
function makeApp(
  config: Config,
  opts: {
    stats?: boolean;
    onApply?: (c: Config) => void;
    address?: string;
    /** 注入假 IP 回显服务 —— 不打真实网络。 */
    probeServices?: Array<{ url: string; extract: (text: string) => string | null }>;
  } = {},
) {
  let current = config;
  const scheduler = new Scheduler();
  const egress = new EgressService({
    timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
    ...(opts.probeServices !== undefined ? { services: opts.probeServices } : {}),
    probeTimeoutMs: 3000,
  });
  const catalog = new ModelCatalog();

  /*
   * 假统计源**记下每次收到的 sinceDay**。
   *
   * 只断言响应里的 `sinceDay` 字段是不够的:那个字段由 handler 自己填,
   * 而真正要验的是它**被传给了聚合函数** —— `requestCounts` 的
   * `COUNT(DISTINCT request_id)` 全表扫且同步(实测 1M 行约 124ms),
   * 不传 sinceDay 会阻塞事件循环那么久。变异测试证实了这个区别:
   * 把 `since` 写死成 undefined 后,只查响应字段的版本依然全绿。
   */
  const seen: Array<string | undefined> = [];
  const stats = {
    modelUsage: (d?: string) => {
      seen.push(d);
      return [];
    },
    workerTotals: () => [],
    rates: (d?: string) => {
      seen.push(d);
      return { cacheHitRate: null, usageCoverage: null, droppedUsageCount: 0 };
    },
    rejectionsByReason: (d?: string) => {
      seen.push(d);
      return { not_free: 3 };
    },
    requestCounts: (d?: string) => {
      seen.push(d);
      return { requests: 7, attempts: 9 };
    },
  };

  const app = createApp({
    configOf: () => current,
    egress,
    catalog,
    scheduler,
    /*
     * `app.request()` 起不了真 socket,所以 `getConnInfo` 拿不到对端地址 →
     * 一律判否 → 管理端点恒为 403,整套 API 无从验证。这里注入地址**来源**,
     * 判定逻辑仍是真实的 `isLoopbackAddress`(见 app.ts 里的说明)。
     */
    addressOf: () => opts.address ?? "127.0.0.1",
    admin: {
      configOf: () => current,
      applyConfig: async (next) => {
        current = next;
        opts.onApply?.(next);
      },
      runtimeWorkers: () => scheduler.runtimeWorkers(current, Date.now()),
      catalog,
      egress,
      health: () => ({
        ok: true,
        version: "test",
        uptimeSeconds: 1,
        pid: 999,
        storeWriteFailures: 0,
      }),
      ...(opts.stats === false ? {} : { stats }),
    },
  });

  return { app, scheduler, getConfig: () => current, seenSinceDay: seen };
}

async function get(app: Hono, path: string) {
  const res = await app.request(`http://127.0.0.1${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function patch(app: Hono, body: unknown) {
  const res = await app.request("http://127.0.0.1/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

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
        // 启用了但**没有 key** —— `isUsable()` 会过滤掉它。
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
    expect(byId.get("nokey")).toMatchObject({ enabled: true, inPool: false, ready: false });
    expect(byId.get("off")).toMatchObject({ enabled: false, inPool: false, ready: false });
    expect(byId.get("on")).toMatchObject({ enabled: true, inPool: true, ready: true });

    // 池计数只算在候选池里的 —— 停用与没 key 的都不算。
    expect(parsed.pool).toMatchObject({ ready: 1, total: 1, health: "healthy" });
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
     * 缺口 #14 的要求是「管理 API 应当总是传它」,而那是对**调用**的要求。
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
 * 写入：凭证的三态语义
 * ================================================================== */

describe("配置写入不会静默抹掉凭证", () => {
  it("patch 里不提 apiKey 时它保持原值", () => {
    const config = makeConfig();
    const result = applyConfigPatch(config, { workers: { update: { w1: { name: "改个名" } } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /*
     * 这是整个写入路径最危险的一条:前端**拿不到** apiKey 原值(投影只给
     * present),所以不能靠「回传原值」表达「不动它」。若用 `apiKey?: string`
     * 表达,一个未填的输入框会静默抹掉能用的 key,然后那个 Worker 被
     * `isUsable()` 过滤掉、界面上看起来仍然 enabled。
     */
    expect(result.config.workers[0]!.apiKey).toBe(KEY_A);
    expect(result.config.workers[0]!.name).toBe("改个名");
  });

  it("清空凭证必须显式说 clear,而 schema 仍有最终否决权", () => {
    const config = makeConfig();

    /*
     * ## 实测纠正了我的预期
     *
     * 我以为 `{clear:true}` 会把 apiKey 清成空串。实际被 **422 拒绝** ——
     * `WorkerSchema` 的 `refine` 要求「登录态 Worker 必须有 apiKey」，
     * 而全量校验在合并之后跑。
     *
     * **这是对的**：清掉 key 会让那个 Worker 被 `isUsable()` 过滤掉、
     * 界面上看起来仍然 enabled 却从不被选中 —— 一个静默失效的配置。
     * 与其允许它然后在界面上解释，不如在写入时就拒绝，让用户
     * 「要么换一个 key，要么停用它」。
     *
     * 所以 `clear` 的真实用途是 `relayToken` 这类**允许为空**的字段
     * （schema 上是 `.min(16)`，所以那里也会被拒）、以及将来
     * `proxies[].password` 这种确实可为空的凭证。保留这条路径 + 钉住
     * 「它不会静默成功」这个性质。
     */
    const cleared = applyConfigPatch(config, {
      workers: { update: { w1: { apiKey: { clear: true } } } },
    });
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) {
      expect(cleared.failure.kind).toBe("invalid_config");
      // 报错要指到字段，且**不含 key 的值**。
      expect(cleared.failure.message).toContain("workers");
      expect(cleared.failure.message).not.toContain(KEY_A);
    }

    // 换成新值则正常生效。
    const replaced = applyConfigPatch(config, {
      workers: { update: { w1: { apiKey: { set: "new-key-value" } } } },
    });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) expect(replaced.config.workers[0]!.apiKey).toBe("new-key-value");
  });

  it("停用一个 Worker 时不必也给 key —— 两件事互不牵连", () => {
    /*
     * 这条与上一条配套:既然「清 key」被拒,那么「我不想用这个账号了」
     * 的正确做法必须是可用的 —— 否则用户只剩「手工编辑 config.json」一条路。
     */
    const result = applyConfigPatch(makeConfig(), {
      workers: { update: { w1: { enabled: false } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.workers[0]!.enabled).toBe(false);
      // key 原样保留 —— 停用不是「用户修好了这个账号」,状态该留着。
      expect(result.config.workers[0]!.apiKey).toBe(KEY_A);
    }
  });

  it("proxyId: null 是「改为直连」,与缺席不同", () => {
    const config = makeConfig();

    const toDirect = applyConfigPatch(config, {
      workers: { update: { w1: { proxyId: null } } },
    });
    expect(toDirect.ok).toBe(true);
    if (toDirect.ok) expect(toDirect.config.workers[0]!.proxyId).toBeNull();

    const untouched = applyConfigPatch(config, { workers: { update: { w1: { name: "x" } } } });
    expect(untouched.ok).toBe(true);
    if (untouched.ok) expect(untouched.config.workers[0]!.proxyId).toBe("p1");
  });

  it("端到端:改配置后凭证一个都没变", async () => {
    const config = makeConfig();
    const { app, getConfig } = makeApp(config);

    const { status } = await patch(app, { workers: { update: { w1: { name: "美国出口" } } } });
    expect(status).toBe(200);

    const after = getConfig();
    expect(after.gateway.relayToken).toBe(TOKEN);
    expect(after.workers[0]!.apiKey).toBe(KEY_A);
    expect(after.workers[1]!.apiKey).toBe(KEY_B);
    expect(after.clash.bridges[0]!.apiSecret).toBe(CLASH_SECRET);
    expect(after.workers[0]!.name).toBe("美国出口");
  });
});

/* ================================================================== *
 * 写入：失败要分类，且不落盘
 * ================================================================== */

describe("写入失败分类", () => {
  it("未知 Worker id → 404,**不静默跳过**", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const before = JSON.stringify(getConfig());

    const { status, body } = await patch(app, { workers: { update: { ghost: { name: "x" } } } });

    /*
     * 静默跳过会让「我明明改了」变成查不出的问题:响应 200、刷新后值没变,
     * 而用户不知道是 id 打错了还是没生效。
     */
    expect(status).toBe(404);
    expect((body["error"] as { type: string }).type).toBe("not_found");
    expect(JSON.stringify(getConfig())).toBe(before);
  });

  it("引用完整性被破坏 → 422,且不落盘", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    const before = JSON.stringify(getConfig());

    const { status, body } = await patch(app, {
      workers: { update: { w1: { proxyId: "does-not-exist" } } },
    });

    /*
     * 一个指向已删除代理的 Worker 会静默退回本机直连出口,于是它和其他
     * Worker 共用同一个公网 IP —— 而出口隔离正是本项目存在的理由。
     * 这种失败必须在加载配置前就暴露。
     */
    expect(status).toBe(422);
    expect((body["error"] as { type: string }).type).toBe("invalid_config");
    expect(JSON.stringify(getConfig())).toBe(before);
  });

  it("删掉仍被引用的代理会被拒", () => {
    const config = makeConfig();
    // 删 p1 但 w1 还绑着它 —— 跨资源的不一致，管理面最容易产生的形态。
    const result = applyConfigPatch({ ...config, proxies: [config.proxies[1]!] }, {});
    expect(result.ok).toBe(false);
  });

  it("新建重复 id 被拒", () => {
    const result = applyConfigPatch(makeConfig(), {
      workers: { create: [{ id: "w1", name: "", apiKey: "k", proxyId: null, enabled: true }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe("invalid_config");
  });

  it("空 patch 不写盘", async () => {
    let applied = 0;
    const { app } = makeApp(makeConfig(), { onApply: () => (applied += 1) });

    const { status, body } = await patch(app, {});
    expect(status).toBe(200);
    expect(body["changed"]).toBe(false);
    // 无谓的写盘会顺带跑一次 Worker 池 re-sync,只增加出错机会。
    expect(applied).toBe(0);
  });

  it("请求体超过 1 MiB 被拒（管理面的 body 上限）", async () => {
    const { app } = makeApp(makeConfig());
    /*
     * 规划的安全约束:管理 JSON 有上限,而 relay 透传对多模态保持无界。
     * 这条约束此前是**空洞成立**的(管理侧没有任何读 body 的代码),
     * 所以加端点时闸门必须同时到位。
     *
     * ## 载荷必须「超大但其余合法」
     *
     * 第一版用 `name: "x".repeat(2MiB)` —— 而 `WorkerPatchSchema` 有
     * `name.max(200)`,于是 schema 也会拒它,**两条路都返回 400**,
     * 断言无法区分。变异测试因此存活:把上限改成 MAX_SAFE_INTEGER 后
     * 测试依然绿(它撞的是 schema 而不是上限)。
     *
     * 改用大量**合法**的 delete 项:每项都是合法字符串,总体积超 1 MiB。
     * 于是唯一会拒它的就是体积闸门。
     */
    const many = Array.from({ length: 30_000 }, (_, i) => `worker-${i}`.padEnd(40, "0"));
    const body = { workers: { delete: many } };
    expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);

    const { status, body: res } = await patch(app, body);
    expect(status).toBe(400);
    expect((res["error"] as { message: string }).message).toContain("上限");
  });

  it("非 JSON 体被拒,且不回显体内容", async () => {
    const { app } = makeApp(makeConfig());
    const res = await app.request(
      "http://127.0.0.1/api/config",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{ not json" },
      { remoteAddress: "127.0.0.1" } as never,
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain("not json");
  });
});

/* ================================================================== *
 * 热更新真的生效
 * ================================================================== */

describe("配置热更新（缺口 #1）", () => {
  it("改配置后调度器立刻看到新的 Worker 池 —— 不必重启", async () => {
    const config = makeConfig();
    const { app } = makeApp(config);

    const before = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(before.pool.total).toBe(2);

    await patch(app, { workers: { update: { w2: { enabled: false } } } });

    /*
     * `Scheduler.#syncedFrom` 用**引用比较**判断「配置换了没有」,所以
     * `applyConfig` 必须换一个**新对象**。原地改会让引用不变 → 池不 re-sync
     * → 改了配置下一个请求还在用旧的池,而这个偏差**不报任何错**。
     */
    const after = OverviewSchema.parse((await get(app, "/api/overview")).body);
    expect(after.pool.total).toBe(1);
    expect(after.workers.find((w) => w.id === "w2")!.inPool).toBe(false);
  });

  it("applyConfigPatch 不改原配置对象（引用比较要成立）", () => {
    const config = makeConfig();
    const snapshot = JSON.stringify(config);

    const result = applyConfigPatch(config, { workers: { update: { w1: { name: "改了" } } } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 原对象必须**没变** —— 否则引用比较看不出「配置换了」。
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(result.config).not.toBe(config);
  });
});

/* ================================================================== *
 * 管理面仅回环（装配期断言）
 * ================================================================== */

describe("管理路由必须被 loopbackOnly 覆盖（缺口 #8）", () => {
  it("非回环来源一律 403", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    expect((await app.request("http://127.0.0.1/api/overview")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/stats")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/ping")).status).toBe(403);
  });

  it("绝不采信 X-Forwarded-For", async () => {
    const { app } = makeApp(makeConfig(), { address: "203.0.113.9" });
    const res = await app.request("http://127.0.0.1/api/overview", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    });
    /*
     * 该头由客户端任意设置。若用它判断来源,一个远端请求只要带上
     * `X-Forwarded-For: 127.0.0.1` 就能拿到管理面权限。
     */
    expect(res.status).toBe(403);
  });

  it("IPv4-mapped IPv6 的本机请求要放行（双栈监听下的真实形态）", async () => {
    // 实测:客户端连 127.0.0.1 时 getConnInfo 报的就是这个形态。
    const { app } = makeApp(makeConfig(), { address: "::ffff:127.0.0.1" });
    expect((await app.request("http://127.0.0.1/api/ping")).status).toBe(200);
  });

  it("写入端点同样被回环闸门挡住", async () => {
    const { app, getConfig } = makeApp(makeConfig(), { address: "203.0.113.9" });
    const before = JSON.stringify(getConfig());
    const res = await app.request("http://127.0.0.1/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workers: { update: { w1: { name: "远端改的" } } } }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(getConfig())).toBe(before);
  });
});

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

  it("探测成功后 egressIp 落进配置,隔离视图随之成立", async () => {
    /*
     * 这条补的是一个**结构性**缺口:接上 Overview 时实测发现 `isolation`
     * 恒为 `{groups:[], unknownWorkerIds:[全部], isolated:false}` ——
     * 因为 `applyProbeResult()` 那个纯函数**零生产调用点**,探测结果从未
     * 写进 `config.proxies[].egressIp`。于是「按实测 IP 分组」这条规划
     * 核心要求一直没有数据来源。
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
});

/* ================================================================== *
 * 真实落盘
 * ================================================================== */

describe("配置写入是原子的且权限正确", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zg-admin-"));
  });

  it("写盘后文件是 0600 且内容能重新加载", async () => {
    const { saveConfig, loadConfig } = await import("../../src/store/config.ts");
    const config = makeConfig();

    await saveConfig(config, root);

    const { stat } = await import("node:fs/promises");
    const st = await stat(join(root, "data", "config.json"));
    // 整个文件都是凭证 —— 只有属主可读写。
    expect(st.mode & 0o777).toBe(0o600);

    const reloaded = await loadConfig(root);
    expect(reloaded.config.workers[0]!.apiKey).toBe(KEY_A);

    await rm(root, { recursive: true, force: true });
  });

  it("写入的 JSON 不含任何多余字段（schema 是 strict）", async () => {
    const { saveConfig } = await import("../../src/store/config.ts");
    await saveConfig(makeConfig(), root);

    const text = await readFile(join(root, "data", "config.json"), "utf8");
    const parsed = ConfigSchema.safeParse(JSON.parse(text));
    expect(parsed.success).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});

/* ================================================================== *
 * 批次 2 的端点
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
