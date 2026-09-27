import type { Hono } from "hono";
import { createApp } from "../../../src/server/app.ts";
import type { AdminDeps } from "../../../src/server/routes/admin.ts";
import { EgressService } from "../../../src/core/proxy/egress.ts";
import { ModelCatalog } from "../../../src/core/models/catalog.ts";
import { Scheduler } from "../../../src/core/routing/scheduler.ts";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../../src/shared/schema.ts";

/*
 * 管理 API 集成测试共用的装配：一份带凭证的配置、真实 scheduler 的 app，
 * 以及 GET / PATCH 的小封装。凭证常量只在这里定义，泄露断言据此判定。
 */

export const TOKEN = "admin-test-relay-token-not-real";
export const KEY_A = "zen-key-AAAA-must-not-leak";
export const KEY_B = "zen-key-BBBB-must-not-leak";
export const CLASH_SECRET = "clash-secret-must-not-leak";

export function makeConfig(overrides: Record<string, unknown> = {}): Config {
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
export function makeApp(
  config: Config,
  opts: {
    stats?: boolean;
    /** 覆盖假统计源的 `reset`（重置端点的测试用）。 */
    statsReset?: () => number;
    /** 假统计源的 `modelProtocols` 返回值（模型页实测协议）。 */
    modelProtocols?: Map<string, string[]>;
    onApply?: (c: Config) => void;
    address?: string;
    /** 注入假 IP 回显服务 —— 不打真实网络。 */
    probeServices?: Array<{ url: string; extract: (text: string) => string | null }>;
    /** 注入假订阅 fetch —— 不打真实网络。 */
    subscriptionFetch?: { fetchImpl?: typeof fetch; now?: () => number; userAgent?: string };
    /** 追加的管理面依赖（opencode 根目录、批测执行器、诊断钩子等）。 */
    admin?: Partial<AdminDeps>;
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
    rejectedModels: (d?: string) => {
      seen.push(d);
      return [{ reason: "not_free", model: "fake-paid-model", count: 3 }];
    },
    daily: (d?: string) => {
      seen.push(d);
      return { byModel: [], byWorker: [] };
    },
    reset: () => opts.statsReset?.() ?? 0,
    modelProtocols: (d?: string) => {
      seen.push(d);
      return opts.modelProtocols ?? new Map<string, string[]>();
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
      effectivePort: () => current.gateway.port,
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
      ...opts.admin,
    },
  });

  return { app, scheduler, catalog, egress, getConfig: () => current, seenSinceDay: seen };
}

export async function get(app: Hono, path: string) {
  const res = await app.request(`http://127.0.0.1${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function patch(app: Hono, body: unknown) {
  const res = await app.request("http://127.0.0.1/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function post(app: Hono, path: string, body?: unknown) {
  const res = await app.request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as Record<string, unknown> };
}
