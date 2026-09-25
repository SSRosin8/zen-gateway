import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  ModelListSchema,
  OverviewSchema,
  ProbeReportSchema,
  ProxyListSchema,
  StatsViewSchema,
} from "../../src/shared/contract.ts";
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
    /** 注入假订阅 fetch —— 不打真实网络（Phase 10）。 */
    subscriptionFetch?: { fetchImpl?: typeof fetch; now?: () => number; userAgent?: string };
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
      ...(opts.subscriptionFetch === undefined ? {} : { subscriptionFetch: opts.subscriptionFetch }),
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

  it("**同一请求里 `delete X` + `create X` 净效果是新建**（缺口 #27）", () => {
    /*
     * 文件头承诺「删掉一个又同名新建的净效果是新建，而不是建完又被删掉」，
     * 而先前的重复 id 检查看的是 `next.workers`（那里还有待删的那个）——
     * 于是这个请求被拒，**注释与行为相反**。用户想换一个 Worker 的 id/key
     * 时必须发两次请求，而中间那一刻配置里少了一个 Worker。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      workers: {
        create: [{ id: "w1", name: "换过的", apiKey: "brand-new-key-value", proxyId: null, enabled: true }],
        delete: ["w1"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 只剩一个 w1，且是**新的**那个 —— 删掉的是旧的（create 追加、delete 取首个匹配）。
    const w1 = result.config.workers.filter((w) => w.id === "w1");
    expect(w1).toHaveLength(1);
    expect(w1[0]!.name).toBe("换过的");
    expect(w1[0]!.apiKey).toBe("brand-new-key-value");
    expect(result.changed).toBe(true);
  });

  it("不在 delete 里的重复 id 仍然被拒", () => {
    /*
     * 上一条放开的只是"同请求内要删的那个"。单纯的重复新建必须照旧报错 ——
     * 否则那条检查就等于没有了。
     */
    const result = applyConfigPatch(makeConfig(), {
      workers: {
        create: [{ id: "w1", name: "撞了", apiKey: "k-some-value", proxyId: null, enabled: true }],
        delete: ["w2"],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("invalid_config");
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

  it("**把字段写成当前值不算改** —— 表单式保存不该每次都写盘（缺口 #26）", async () => {
    /*
     * 先前 `changed` 是按"这个字段有没有出现在 patch 里"判定的，
     * 于是把一个字段写成它**当前的值**也算改了。而管理 UI 提交的是整张表单
     * —— 网关页每次「保存」都会触发一次原子写 + Worker 池 re-sync，
     * 即使用户什么都没动。`admin.ts` 的注释承诺的正是相反的行为。
     *
     * `config.json` 是唯一一份凭证存储，写它不是免费的；而 re-sync 会让
     * 池重建一次，只增加出错机会。
     */
    const config = makeConfig();
    let applied = 0;
    const { app } = makeApp(config, { onApply: () => (applied += 1) });

    // 一、写成当前值 → 不算改，不写盘。
    const same = await patch(app, { gateway: { maxAttempts: config.gateway.maxAttempts } });
    expect(same.status).toBe(200);
    expect(same.body["changed"]).toBe(false);
    expect(applied).toBe(0);

    // 二、真的改一个值 → 算改，写盘。
    const diff = await patch(app, { gateway: { maxAttempts: config.gateway.maxAttempts + 1 } });
    expect(diff.status).toBe(200);
    expect(diff.body["changed"]).toBe(true);
    expect(applied).toBe(1);
  });

  it("整张表单原样回传（多字段全等于当前值）也不算改", () => {
    /*
     * 这是上一条的真实形态 —— UI 提交的不是单个字段。
     * 用纯函数直接验，不经 HTTP：要钉的是合并层的判定。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      gateway: {
        maxAttempts: config.gateway.maxAttempts,
        headersTimeoutMs: config.gateway.headersTimeoutMs,
        bodyTimeoutMs: config.gateway.bodyTimeoutMs,
      },
      models: {
        freeSuffix: config.models.freeSuffix,
        extraFreeIds: [...config.models.extraFreeIds],
        catalogTtlMs: config.models.catalogTtlMs,
        enforceCatalog: config.models.enforceCatalog,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  it("`{set}` 成同一个凭证值也不算改", () => {
    /*
     * 凭证是三态写入里最容易误判的：前端拿不到原值，所以它**不会**回传
     * —— 但一个脚本可能会。写成同一个值仍然不该触发写盘。
     */
    const config = makeConfig();
    const result = applyConfigPatch(config, {
      gateway: { relayToken: { set: config.gateway.relayToken } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);

    // 换一个值就该算改。
    const other = applyConfigPatch(config, {
      gateway: { relayToken: { set: "a-different-relay-token-value" } },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.changed).toBe(true);
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

  it("**`POST /batch-probe` 也有上限** —— 上限属于闸门，不属于某个调用点", async () => {
    /*
     * 第十轮审核实测：`MAX_ADMIN_BODY_BYTES` 是本文件的常量，而两个写端点里
     * 只有 `PATCH /config` 用它 —— `/batch-probe` 直接 `c.req.json()`，
     * 8 MiB 的体被照常接受。也就是说"管理 JSON 有上限"这条约束
     * **只覆盖了一半的写端点**，而文件头把它写成已兑现。
     */
    const { app } = makeApp(makeConfig());
    const body = { action: "start", padding: "x".repeat(2 * 1024 * 1024) };
    expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);

    const res = await app.request(
      "http://127.0.0.1/api/batch-probe",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      { remoteAddress: "127.0.0.1" } as never,
    );

    /*
     * 400 而不是 500：体积闸门排在 `deps.batch === undefined` 那个业务检查
     * **之前**。反过来的话，一个 8 MiB 的请求在 runner 未就绪时会先被完整
     * 读进内存再返回 500 —— 而闸门存在的理由正是"不要读那么多"。
     */
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { message?: string } };
    expect(json.error?.message).toContain("上限");
  });

  it("**chunked 编码绕不过上限** —— `content-length` 可以缺席", async () => {
    /*
     * 先前的实现先查 `content-length`、再读完量一次。第一道对
     * `transfer-encoding: chunked` 无效（那个头根本不给），第二道在
     * 体已进内存之后。这里用流式请求体复现"没有 content-length"的形态：
     * 判据是网关**读入的字节数**，而不是它最终是否返回 400。
     */
    const { app } = makeApp(makeConfig());
    const CHUNK = 256 * 1024;
    const TOTAL = 16 * 1024 * 1024;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= TOTAL) {
          controller.close();
          return;
        }
        produced += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
      },
    });

    const res = await app.request(
      "http://127.0.0.1/api/config",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
        // @ts-expect-error duplex 是流式请求体必需的，TS 的 RequestInit 还没有它
        duplex: "half",
      },
      { remoteAddress: "127.0.0.1" } as never,
    );

    expect(res.status).toBe(400);
    // 上限 1 MiB，客户端想发 16 MiB —— 读入量必须停在上限附近。
    expect(produced / 1048576).toBeLessThan(1 + 2);
  }, 30_000);

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

  it("**探测期间用户改配置不会被覆盖** —— 合并前要重读", async () => {
    /*
     * 第十轮审核实测的丢失更新。`probeAll` 约 6 秒，那几秒足够用户在
     * Worker 页改个名并保存。先前这里用的是探测**开始前**那份快照，
     * 于是探测返回后写回时把用户的改动凭空覆盖 —— 响应 200、
     * `changed: true`，没有任何症状。
     *
     * 同一文件的订阅刷新与 `batchRunner.#persist` 都显式防了这个并写明了
     * 理由；三处同类路径里只有这一处漏了（纪律 #4）。
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

  it("**本机直连的实测 IP 也要落盘并参与隔离分组**（缺口 #28）", async () => {
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

  it("**响应过 schema，且不泄漏凭证**（缺口 #25）", async () => {
    /*
     * 这一条先前是唯一绕过 schema 与投影层的管理响应 —— 它手工拼装
     * `ProbeOutcome` 的字段。今天不泄漏（`reason` 来自
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

/* ================================================================== *
 * 订阅（Phase 10）
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

/* ================================================================== *
 * 凭证清单自己也要有关卡（第十轮审核）
 * ================================================================== */

describe("`allSecretValues` 与 schema 的凭证字段不脱节", () => {
  /*
   * `allSecretValues` 的注释说它「从 `Config` 的实际结构推导」，而实际上
   * 它是**逐字段手写枚举**（`relayToken` / `w.apiKey` / `b.apiSecret` /
   * `p.password` / 订阅 URL）—— 也就是它自己就是那条纪律要避免的手写名单，
   * 只是搬到了 `src/` 下。
   *
   * 第十轮审核的变异：同时把 clash secret 从名单里删掉、并让 `clashView`
   * 真的泄漏它的明文前 8 位 → **62 条全绿**。那正是它声称防住的形态
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
     * 本机实测 4 个（password / apiSecret / apiKey / relayToken）。
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
