import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/store/db/open.ts";
import { StatsStore, dayKey } from "../../src/store/db/stats.ts";
import type { TokenUsage } from "../../src/core/models/usage.ts";

let root: string;
let db: DatabaseSync;
let stats: StatsStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-stats-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  db = openDb(join(root, "data", "runtime.db"));
  stats = new StatsStore(db);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    ...over,
  };
}

describe("dayKey", () => {
  it("按 UTC 切日,不随本地时区变", () => {
    // 这两个时刻在 UTC 是同一天,在 UTC+8 会跨日。
    expect(dayKey(Date.UTC(2026, 8, 24, 0, 30))).toBe("2026-09-24");
    expect(dayKey(Date.UTC(2026, 8, 24, 23, 30))).toBe("2026-09-24");
    expect(dayKey(Date.UTC(2026, 8, 25, 0, 30))).toBe("2026-09-25");
  });
});

describe("请求数 ≠ 尝试数", () => {
  /*
   * 这是本模块最容易搞错、也最要紧的一条语义。一条重试链是**一个**客户端
   * 请求、**多次**上游尝试；两个数字都要能查到，且每次尝试都要在对应
   * Worker 上可见（否则「这个 Worker 转发过什么」无从查证）。
   */
  it("一条重试链算一个请求、多次尝试,且每个 Worker 都可见", () => {
    const req = "req-1";
    stats.recordAttempt({
      requestId: req,
      attemptIndex: 0,
      workerId: "w1",
      protocol: "chat",
      model: "m",
      status: 429,
      failureKind: "rate_limit",
      latencyMs: 12,
      at: T0,
    });
    stats.recordAttempt({
      requestId: req,
      attemptIndex: 1,
      workerId: "w2",
      protocol: "chat",
      model: "m",
      status: 200,
      failureKind: null,
      latencyMs: 30,
      at: T0 + 1,
    });

    expect(stats.requestCounts()).toEqual({ requests: 1, attempts: 2 });

    const byWorker = new Map(stats.workerTotals().map((w) => [w.workerId, w]));
    expect(byWorker.get("w1")).toMatchObject({ attempts: 1, successes: 0, failures: 1 });
    expect(byWorker.get("w2")).toMatchObject({ attempts: 1, successes: 1, failures: 0 });
  });

  it("两条请求各自成功 → 2 个请求 2 次尝试", () => {
    for (const [i, req] of ["a", "b"].entries()) {
      stats.recordAttempt({
        requestId: req,
        attemptIndex: 0,
        workerId: "w1",
        protocol: "chat",
        model: "m",
        status: 200,
        failureKind: null,
        latencyMs: 5,
        at: T0 + i,
      });
    }
    expect(stats.requestCounts()).toEqual({ requests: 2, attempts: 2 });
  });
});

describe("worker_stats 累计", () => {
  it("多次尝试累加,last_used_at 取最近一次(含失败那次)", () => {
    stats.recordAttempt({
      requestId: "r1",
      attemptIndex: 0,
      workerId: "w1",
      protocol: "chat",
      model: "m",
      status: 200,
      failureKind: null,
      latencyMs: 1,
      at: T0,
    });
    stats.recordAttempt({
      requestId: "r2",
      attemptIndex: 0,
      workerId: "w1",
      protocol: "chat",
      model: "m",
      status: 500,
      failureKind: "upstream_error",
      latencyMs: 2,
      at: T0 + 5_000,
    });

    const [w] = stats.workerTotals();
    expect(w).toMatchObject({
      workerId: "w1",
      attempts: 2,
      successes: 1,
      failures: 1,
      // 「最近一次被用到」包括失败那次 —— 那正是排查时想知道的。
      lastUsedAt: T0 + 5_000,
      lastStatus: 500,
    });
  });

  it("传输失败时 last_status 为 null,不伪造一个码", () => {
    stats.recordAttempt({
      requestId: "r1",
      attemptIndex: 0,
      workerId: "w1",
      protocol: "chat",
      model: "m",
      status: null,
      failureKind: "transport",
      latencyMs: 60_000,
      at: T0,
    });
    expect(stats.workerTotals()[0]?.lastStatus).toBeNull();
  });
});

describe("用量:缺失如实记为缺失", () => {
  /*
   * 规划明写「缺失的 usage 如实显示为缺失，不估算」。做到它的前提是
   * **没报用量的那次请求也要留一行** —— 否则覆盖率的分母漏掉它，
   * 于是一个「上游从不报用量」的模型会显示成 100% 覆盖。
   */
  it("usage 为 null 时进 requests_without_usage,不进 token 累计", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null });

    const [row] = stats.modelUsage();
    expect(row).toMatchObject({
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      requestsWithUsage: 0,
      requestsWithoutUsage: 1,
    });
  });

  it("覆盖率 = 带 usage ÷ 全部", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null });

    expect(stats.rates().usageCoverage).toBeCloseTo(1 / 3, 10);
  });

  it("同一 (model, worker, day) 累加而不是覆盖", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0 + 1_000, usage: usage() });

    const [row] = stats.modelUsage();
    expect(row).toMatchObject({ inputTokens: 200, outputTokens: 40, requestsWithUsage: 2 });
  });

  it("跨天分行,聚合时合并", () => {
    const nextDay = T0 + 24 * 3_600_000;
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: nextDay, usage: usage() });

    expect(stats.modelUsage()[0]).toMatchObject({ requestsWithUsage: 2, inputTokens: 200 });
    // sinceDay 只取后一天。
    expect(stats.modelUsage(dayKey(nextDay))[0]).toMatchObject({ requestsWithUsage: 1 });
  });

  it("不同 Worker 的同一模型在 per-model 聚合里合并", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w2", at: T0, usage: usage() });

    expect(stats.modelUsage()).toHaveLength(1);
    expect(stats.modelUsage()[0]).toMatchObject({ requestsWithUsage: 2 });
  });
});

describe("派生比值:分母为 0 给 null 而不是 0", () => {
  /*
   * 「没有数据」与「命中率是 0%」是两件不同的事：前者在 UI 上该显示 "—"，
   * 后者是一个需要排查的真实数字。给 0 会把前者伪装成后者。
   */
  it("空库两个比值都是 null", () => {
    expect(stats.rates()).toEqual({ cacheHitRate: null, usageCoverage: null });
  });

  it("有请求但 token 全 0 时,覆盖率有值而命中率仍是 null", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null });
    const r = stats.rates();
    expect(r.usageCoverage).toBe(0);
    // 输入 token 为 0 → 命中率没有分母。
    expect(r.cacheHitRate).toBeNull();
  });

  it("命中率 = 命中读 ÷ 总输入", () => {
    stats.recordUsage({
      model: "m",
      workerId: "w1",
      at: T0,
      usage: usage({ promptTokens: 1_000, cacheReadTokens: 250 }),
    });
    expect(stats.rates().cacheHitRate).toBeCloseTo(0.25, 10);
  });

  it("全部命中时命中率为 1,不因分母写法而除零", () => {
    // 若分母误写成 `prompt - cacheRead`，这里会除以 0。
    stats.recordUsage({
      model: "m",
      workerId: "w1",
      at: T0,
      usage: usage({ promptTokens: 500, cacheReadTokens: 500 }),
    });
    expect(stats.rates().cacheHitRate).toBe(1);
  });
});

describe("大数不让聚合崩掉", () => {
  /*
   * 实测过的坑：`node:sqlite` 的 `SUM()` 越过 `Number.MAX_SAFE_INTEGER` 时
   * **会抛**（`Value is too large to be represented as a JavaScript number`），
   * 不是静默失真。于是一个跑久了的库会让统计查询直接报错。
   */
  it("累计到饱和值仍能查询,不抛", () => {
    const huge = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 3; i += 1) {
      stats.recordUsage({
        model: "m",
        workerId: `w${i}`,
        at: T0,
        usage: usage({ promptTokens: huge, totalTokens: huge }),
      });
    }

    // 三行各 MAX_SAFE，SUM 会越界 —— 必须被夹住而不是抛。
    const rows = stats.modelUsage();
    expect(rows[0]?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => stats.rates()).not.toThrow();
    expect(stats.rates().cacheHitRate).toBe(0);
  });
});

describe("写入失败吞掉但可观测", () => {
  it("库关掉后写入不抛,并计入 writeFailures", () => {
    db.close();

    expect(() =>
      stats.recordAttempt({
        requestId: "r",
        attemptIndex: 0,
        workerId: "w1",
        protocol: "chat",
        model: "m",
        status: 200,
        failureKind: null,
        latencyMs: 1,
        at: T0,
      }),
    ).not.toThrow();
    expect(() =>
      stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() }),
    ).not.toThrow();

    const f = stats.writeFailures();
    expect(f.count).toBe(2);
    // 吞掉不等于可以不知道 —— 一直写失败的库会安静地给出全 0 报表。
    expect(f.lastError).not.toBeNull();

    /*
     * 重新打开是**必需的**，不是清理礼节：`afterEach` 会再 close 一次，
     * 而 `node:sqlite` 对重复 close **会抛** `database is not open`（实测）。
     * 重新赋值让 afterEach 关到一个新的、打开的库。
     *
     * （先前这里的注释写的是"node:sqlite 对重复 close 是容忍的" —— 那是
     * 事实错误，会让下一个人以为可以删掉这一行。）
     */
    db = openDb(join(root, "data", "runtime.db"));
  });
});

describe("recentAttempts", () => {
  it("按时间倒序,并夹住 limit", () => {
    for (let i = 0; i < 5; i += 1) {
      stats.recordAttempt({
        requestId: `r${i}`,
        attemptIndex: 0,
        workerId: "w1",
        protocol: "chat",
        model: "m",
        status: 200,
        failureKind: null,
        latencyMs: 1,
        at: T0 + i * 1_000,
      });
    }
    const rows = stats.recentAttempts(3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.requestId)).toEqual(["r4", "r3", "r2"]);

    // limit 越界不报错，夹到合法范围。
    expect(stats.recentAttempts(0)).toHaveLength(1);
    expect(stats.recentAttempts(10_000)).toHaveLength(5);
  });
});
