import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../../src/core/models/catalog.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { openDb } from "../../src/store/db/open.ts";
import { StatsStore } from "../../src/store/db/stats.ts";
import { AffinityStore } from "../../src/store/db/affinityStore.ts";

/**
 * Phase 7 的集成测试 —— 统计写入与亲和持久化，对着**真实假上游 + 真实 SQLite** 跑。
 *
 * ## 为什么这些必须是集成测试
 *
 * 单测能验 `StatsStore` 按给定入参写对了行，但验不了**转发路径真的把
 * 那些入参凑对了**：中间隔着重试链的 `onAttempt`、流末尾的 `onDone`、
 * 以及「用量归属实际承接者而非候选链首位」这条只在重试发生时才分叉的规则。
 *
 * Phase 5/6 已有两次先例：「一条客户端请求发了几次上游」与「会话绑定停在
 * 候选链首位」都只有集成测试查得出来 —— 纯单测看不见跨层的次序。
 */

const TOKEN = "phase7-test-token-x";

type Req = import("node:http").IncomingMessage;
type Res = import("node:http").ServerResponse;

let upstream: Server;
let upstreamPort: number;
let handler: (req: Req, res: Res) => void;
let egress: EgressService;
let root: string;
let db: DatabaseSync;
let stats: StatsStore;
let affinityStore: AffinityStore;

const LIVE_IDS = ["big-pickle", "nemotron-3-ultra-free"];

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", usage: { prompt_tokens: 40, completion_tokens: 10 } }));
  };

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: LIVE_IDS.map((id) => ({ id })) }));
        return;
      }
      handler(req, res);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
  upstreamPort = addr.port;

  egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });

  root = await mkdtemp(join(tmpdir(), "zg-p7-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  db = openDb(join(root, "data", "runtime.db"));
  stats = new StatsStore(db);
  affinityStore = new AffinityStore(db);
});

afterEach(async () => {
  await egress.close();
  upstream.close();
  await once(upstream, "close");
  db.close();
  await rm(root, { recursive: true, force: true });
});

function config(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
    workers: [
      { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-w1-not-real", enabled: true, proxyId: null },
      { id: "w2", name: "", kind: "authenticated", apiKey: "fake-key-w2-not-real", enabled: true, proxyId: null },
    ],
    ...over,
  });
}

function relay(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function warmCatalog(cfg: Config): Promise<ModelCatalog> {
  const catalog = new ModelCatalog();
  await catalog.ensure(catalogIdentityOf(cfg), cfg, (c) => egress.upstreamDeps(c));
  return catalog;
}

async function makeApp(cfg: Config, scheduler?: Scheduler) {
  return createApp({
    configOf: () => cfg,
    egress,
    catalog: await warmCatalog(cfg),
    scheduler: scheduler ?? new Scheduler({ affinitySink: affinityStore }),
    stats,
    log: () => {},
  });
}

const chatBody = (over: Record<string, unknown> = {}) => ({
  model: "big-pickle",
  messages: [{ role: "user", content: "hi" }],
  ...over,
});

describe("统计真的经转发路径落库", () => {
  it("一次成功请求写下一条尝试、一条用量、一个 Worker 计数", async () => {
    const app = await makeApp(config());
    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    expect(res.status).toBe(200);
    // 用量在流末尾的 onDone 里记 —— 必须先把响应读完。
    await res.text();

    expect(stats.requestCounts()).toEqual({ requests: 1, attempts: 1 });

    const [attempt] = stats.recentAttempts();
    expect(attempt).toMatchObject({
      workerId: "w1",
      protocol: "chat",
      model: "big-pickle",
      status: 200,
      failureKind: null,
    });
    // 耗时是真实测量的，不是写死的 0。
    expect(attempt?.latencyMs).toBeGreaterThanOrEqual(0);

    const [usageRow] = stats.modelUsage();
    expect(usageRow).toMatchObject({
      model: "big-pickle",
      inputTokens: 40,
      outputTokens: 10,
      requestsWithUsage: 1,
      requestsWithoutUsage: 0,
    });

    expect(stats.workerTotals()).toEqual([
      expect.objectContaining({ workerId: "w1", attempts: 1, successes: 1, failures: 0 }),
    ]);
  });

  it("统计写入失败不影响转发 —— 库关掉后请求照样 200", async () => {
    const app = await makeApp(config());
    db.close();

    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    // 转发是主路径，统计是诊断设施：后者坏了不该拖垮前者。
    expect(res.status).toBe(200);
    await res.text();
    expect(stats.writeFailures().count).toBeGreaterThan(0);

    db = openDb(join(root, "data", "runtime.db"));
  });

  it("上游没报用量时记进 requests_without_usage,不漏掉这次请求", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // 刻意不带 usage —— 免费模型的响应未必有。
      res.end(JSON.stringify({ id: "x" }));
    };
    const app = await makeApp(config());
    await (await app.request("/v1/chat/completions", relay(chatBody()))).text();

    expect(stats.modelUsage()[0]).toMatchObject({
      requestsWithUsage: 0,
      requestsWithoutUsage: 1,
      inputTokens: 0,
    });
    // 覆盖率因此是 0 而不是 null，也不是 1 —— 分母数上了这次请求。
    expect(stats.rates().usageCoverage).toBe(0);
  });
});

describe("重试链的统计语义", () => {
  it("一条 w1 失败 → w2 成功的链 = 1 个请求、2 次尝试,两个 Worker 各自可见", async () => {
    let n = 0;
    handler = (_req, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    };

    const app = await makeApp(config());
    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    expect(res.status).toBe(200);
    await res.text();

    // **这是本模块最容易搞错的一条**：请求数 ≠ 尝试数。
    expect(stats.requestCounts()).toEqual({ requests: 1, attempts: 2 });

    const rows = stats.recentAttempts();
    expect(rows).toHaveLength(2);
    // 同一条链共用 request_id —— 否则「这两次尝试属于同一个请求」查不出来。
    expect(new Set(rows.map((r) => r.requestId)).size).toBe(1);
    // attempt_index 按顺序。
    expect(rows.map((r) => r.attemptIndex).sort()).toEqual([0, 1]);

    const byWorker = new Map(stats.workerTotals().map((w) => [w.workerId, w]));
    expect(byWorker.get("w1")).toMatchObject({ attempts: 1, failures: 1, successes: 0 });
    expect(byWorker.get("w2")).toMatchObject({ attempts: 1, failures: 0, successes: 1 });
  });

  it("用量归属**实际承接者**,不是候选链首位", async () => {
    /*
     * 这条只有集成测试查得出来，而且它有先例：Phase 5 的「会话绑定停在候选链
     * 首位而非实际承接者」是同一个形态的缺陷。若用量记到 w1 名下，
     * 「哪个账号烧了多少 token」这个问题的答案就是错的 —— 而那正是
     * 多账号出口隔离场景下最要紧的一个数字。
     */
    let n = 0;
    handler = (_req, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(500, {});
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", usage: { prompt_tokens: 99, completion_tokens: 1 } }));
    };

    const app = await makeApp(config());
    await (await app.request("/v1/chat/completions", relay(chatBody()))).text();

    const rows = db
      .prepare("SELECT worker_id, input_tokens FROM model_usage")
      .all() as Array<{ worker_id: string; input_tokens: number }>;
    expect(rows).toEqual([{ worker_id: "w2", input_tokens: 99 }]);
  });

  it("网关在请求出去之前拒掉时,不写任何尝试", async () => {
    const app = await makeApp(config());
    // 付费模型 → 免费闸门在第 3 步拒绝，压根没有上游尝试。
    const res = await app.request("/v1/chat/completions", relay(chatBody({ model: "claude-opus-5" })));
    expect(res.status).toBe(403);

    // 一次没发生的上游尝试不该出现在 upstream_attempts 里 ——
    // 否则「这个 Worker 转发过什么」会包含它根本没参与的请求。
    expect(stats.requestCounts()).toEqual({ requests: 0, attempts: 0 });
  });
});

describe("亲和持久化:重启后粘滞不归零", () => {
  it("重启后同一会话仍路由到原 Worker", async () => {
    const cfg = config();
    const session = "sticky-session-1";

    // 第一轮：建立绑定。
    const first = await makeApp(cfg);
    const r1 = await first.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r1.text();
    const firstWorker = r1.headers.get("x-zen-gateway-worker");
    expect(firstWorker).not.toBeNull();

    // 模拟重启：全新的 Scheduler（空内存），只通过 DB 恢复。
    const revived = new Scheduler({ affinitySink: affinityStore });
    const now = Date.now();
    revived.restoreAffinity(affinityStore.loadSessions(now), affinityStore.loadBlobs(now));

    const second = await makeApp(cfg, revived);
    const r2 = await second.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r2.text();

    expect(r2.headers.get("x-zen-gateway-worker")).toBe(firstWorker);
    // 命中的是恢复来的绑定，而不是"碰巧又选了同一个" ——
    // `sticky` 正是 select.ts 里会话亲和命中的那个 reason。
    expect(r2.headers.get("x-zen-gateway-route")).toBe("sticky");
  });

  it("不传 affinitySink 时重启后绑定归零(对照)", async () => {
    /*
     * 反向断言：证明上一条测的是**持久化**在起作用，
     * 而不是"候选链顺序恰好稳定"这种与本特性无关的原因。
     */
    const cfg = config();
    const session = "sticky-session-2";

    const first = await makeApp(cfg, new Scheduler());
    await (
      await first.request(
        "/v1/chat/completions",
        relay(chatBody(), { "x-opencode-session": session }),
      )
    ).text();

    // 没有 sink → 库里什么都没有。
    expect(affinityStore.loadSessions(Date.now())).toHaveLength(0);

    const revived = new Scheduler();
    const second = await makeApp(cfg, revived);
    const r2 = await second.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r2.text();
    // 空内存 → 走策略排序，不是亲和命中。
    expect(r2.headers.get("x-zen-gateway-route")).toBe("strategy");
  });

  it("会话绑定落库的是摘要,不是原始会话标识", async () => {
    const cfg = config();
    const session = "a-very-recognizable-session-id";
    const app = await makeApp(cfg);
    await (
      await app.request(
        "/v1/chat/completions",
        relay(chatBody(), { "x-opencode-session": session }),
      )
    ).text();

    const rows = affinityStore.loadSessions(Date.now());
    expect(rows).toHaveLength(1);
    // 原值绝不能进库 —— 它来自客户端，而这张表会进备份与诊断导出。
    expect(rows[0]?.hash).not.toContain("recognizable");
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
