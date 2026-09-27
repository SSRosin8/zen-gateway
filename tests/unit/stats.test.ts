import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../../src/store/db/open.ts";
import { StatsStore, dayKey, UNKNOWN_MODEL } from "../../src/store/db/stats.ts";
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
   * 需求明写「缺失的 usage 如实显示为缺失，不估算」。做到它的前提是
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

describe("带会话的用量每段会话只算一次", () => {
  /*
   * OpenCode 每一轮都带着完整上下文，上游报的是整段对话到此为止的用量。
   * 逐条相加会把同一段上下文重复算很多遍（用户实测看到的偏大）。
   */
  it("同一会话多轮只保留最大的那条，请求计数仍逐条累计", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage({ promptTokens: 1_000, completionTokens: 10 }), sessionHash: "s1" });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0 + 1, usage: usage({ promptTokens: 3_000, completionTokens: 30, cacheReadTokens: 900 }), sessionHash: "s1" });
    // 同一会话里晚到的小请求（例如标题生成）不能把整段会话覆盖成它。
    stats.recordUsage({ model: "m", workerId: "w2", at: T0 + 2, usage: usage({ promptTokens: 50, completionTokens: 5 }), sessionHash: "s1" });

    expect(stats.modelUsage()[0]).toMatchObject({
      inputTokens: 3_000,
      outputTokens: 30,
      cacheReadTokens: 900,
      requestsWithUsage: 3,
    });
    expect(stats.rates().cacheHitRate).toBeCloseTo(0.3, 10);
  });

  it("不同会话、无会话请求各自累加", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: "s1" });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: "s2" });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: null });
    expect(stats.modelUsage()[0]).toMatchObject({ inputTokens: 400, requestsWithUsage: 4 });
  });

  it("同一会话换模型时按模型分开", () => {
    stats.recordUsage({ model: "a", workerId: "w1", at: T0, usage: usage(), sessionHash: "s1" });
    stats.recordUsage({ model: "b", workerId: "w1", at: T0, usage: usage({ promptTokens: 7 }), sessionHash: "s1" });
    const byModel = Object.fromEntries(stats.modelUsage().map((r) => [r.model, r.inputTokens]));
    expect(byModel).toEqual({ a: 100, b: 7 });
  });

  it("会话里没报用量的请求不清掉已知用量", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: "s1" });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0 + 1, usage: null, sessionHash: "s1" });
    expect(stats.modelUsage()[0]).toMatchObject({ inputTokens: 100, requestsWithUsage: 1, requestsWithoutUsage: 1 });
  });

  it("时间窗按保留那条所在的天计入", () => {
    const nextDay = T0 + 24 * 3_600_000;
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: "s1" });
    stats.recordUsage({ model: "m", workerId: "w1", at: nextDay, usage: usage({ promptTokens: 500 }), sessionHash: "s1" });
    expect(stats.modelUsage(dayKey(nextDay))[0]).toMatchObject({ inputTokens: 500 });
    expect(stats.modelUsage()[0]).toMatchObject({ inputTokens: 500 });
  });
});

describe("被拒模型明细", () => {
  it("按（原因, 模型）合并协议面，按次数降序", () => {
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "paid-a", at: T0 });
    stats.recordRejection({ reason: "not_free", protocol: "responses", model: "paid-a", at: T0 });
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "paid-b", at: T0 });
    stats.recordRejection({ reason: "retired", protocol: "chat", model: "paid-b", at: T0 });
    expect(stats.rejectedModels()).toEqual([
      { reason: "not_free", model: "paid-a", count: 2 },
      { reason: "not_free", model: "paid-b", count: 1 },
      { reason: "retired", model: "paid-b", count: 1 },
    ]);
  });
});

describe("派生比值:分母为 0 给 null 而不是 0", () => {
  /*
   * 「没有数据」与「命中率是 0%」是两件不同的事：前者在 UI 上该显示 "—"，
   * 后者是一个需要排查的真实数字。给 0 会把前者伪装成后者。
   */
  it("空库两个比值都是 null", () => {
    expect(stats.rates()).toEqual({
      cacheHitRate: null,
      usageCoverage: null,
      // 计数型字段给 0 而不是 null —— 它不是比值，"还没有丢过"是个确定的事实。
      droppedUsageCount: 0,
    });
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

  it("**1025 个饱和行**也不抛 —— int64 累加本身的溢出", () => {
    /*
     * 上面那条只灌 3 行，所以它验的是「JS 转换阶段的越界」。
     * 而 `SUM()` 的**累加本身是 int64**：2^53 × 1024 = 2^63，
     * 也就是第 1025 个饱和行会让 SQLite 在 `MIN` 拿到值**之前**就抛
     * `integer overflow`。
     *
     * 实测确认过这个分界（直接喂 SQLite）：
     *   1025 行 × MAX_SAFE → `MIN(SUM(x), MAX_SAFE)` 抛 integer overflow
     *   同样数据    → `CAST(MIN(total(x), MAX_SAFE) AS INTEGER)` 返回 MAX_SAFE
     *
     * 所以「`MIN(SUM())` 已挡住溢出」这个说法**比实际强** —— 它只在 int64 还没溢出的
     * 区间内成立。修法是换 `total()`（恒返回 REAL，而 IEEE754 不溢出）。
     *
     * 可达性极低（要上游持续报天文数字约 9 天），但这条断言的价值不在
     * 可达性 —— 它在于让注释与实际相符：一个声称"已挡住溢出"而实际没挡的
     * 注释，会让下一个人在这上面做判断。
     */
    const huge = Number.MAX_SAFE_INTEGER;
    /*
     * 直接写库而不是走 `recordUsage` —— 那要 1025 次事务，太慢。
     * 这里要造的是**读侧**的输入条件（1025 个饱和行），
     * 写侧的夹取由上面那条独立守着。
     */
    const insert = db.prepare(`
      INSERT INTO model_usage
        (model, worker_id, day, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, requests_with_usage, requests_without_usage, requests_dropped_usage)
      VALUES (?, ?, ?, ?, 0, 0, 0, 1, 0, 0)
    `);
    for (let i = 0; i < 1025; i += 1) {
      insert.run("m", `w${i}`, "2026-09-01", huge);
    }

    // 关键：不抛。`MIN(SUM(...))` 的写法在这里就是 `integer overflow`。
    expect(() => stats.modelUsage()).not.toThrow();
    expect(stats.modelUsage()[0]?.inputTokens).toBe(huge);

    // 另外两个聚合走同一个片段，一起验。
    expect(() => stats.rates()).not.toThrow();
    expect(() => stats.workerTotals()).not.toThrow();
  });
});

describe("写入侧的夹取（与读侧是两层，各自承重）", () => {
  /*
   * 读侧的大数测试只**跨行**灌（三个不同 Worker 各一行），
   * 于是它验的是读侧 `MIN(SUM(...))`；**写入侧 upsert 的累加夹取**
   * （同一 `(model, worker, day)` 反复累加）不会被触发 ——
   * 没有这组测试时，去掉它全绿。
   *
   * 两层都需要：写侧防「累加溢出 INTEGER 列」，读侧防「跨行求和越过
   * MAX_SAFE 让 SUM 抛」。少了写侧，一行自己就能涨到 JS 读不回来的值。
   *
   * 单次就能饱和：`clampTokens` 把上游报的巨数（实测 `prompt_tokens: 1e300`）
   * 夹到 MAX_SAFE，写进库就是一个饱和行。
   */
  it("同一行反复累加 MAX_SAFE 后仍能读回", () => {
    const huge = usage({ promptTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 3; i += 1) {
      stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: huge });
    }

    /*
     * 断言**库里存的原始值**，不是 `modelUsage()` 的返回值 ——
     * 后者的读侧 `MIN(SUM(...))` 会把写侧的溢出掩盖掉，于是断言它等于
     * MAX_SAFE 在两种实现下都通过（我第一版就是这么写的，变异全绿）。
     *
     * 去掉写侧夹取后这一行会存成 27021597764222973，而直接 SELECT 它
     * 会抛 `Value is too large to be represented as a JavaScript number`。
     */
    const raw = db.prepare("SELECT input_tokens FROM model_usage").get();
    expect(raw).toEqual({ input_tokens: Number.MAX_SAFE_INTEGER });
    expect(() => stats.rates()).not.toThrow();
  });

  it("输出与缓存列同样夹住 —— 四个 token 列不能只夹一个", () => {
    const huge = usage({
      promptTokens: Number.MAX_SAFE_INTEGER,
      completionTokens: Number.MAX_SAFE_INTEGER,
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheWriteTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    for (let i = 0; i < 3; i += 1) {
      stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: huge });
    }

    // 同上：断言库里的原始值，读侧的夹取会掩盖写侧的溢出。
    expect(
      db
        .prepare("SELECT output_tokens, cache_read_tokens, cache_write_tokens FROM model_usage")
        .get(),
    ).toEqual({
      output_tokens: Number.MAX_SAFE_INTEGER,
      cache_read_tokens: Number.MAX_SAFE_INTEGER,
      cache_write_tokens: Number.MAX_SAFE_INTEGER,
    });
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
     * （"node:sqlite 对重复 close 是容忍的"是事实错误，
     * 信了它就会以为可以删掉这一行。）
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

describe("网关拒绝（第六项统计）", () => {
  /*
   * 统计共六项，第六项「网关拒绝」需要自己的表与写入点。`relay.ts` 有六条在打上游
   * **之前**就返回的路径，不记录的话全部零记录 —— 403 那条连日志都不打。
   *
   * 那样「我有多少请求被网关自己挡了」完全无法回答，而 `not_free` 与
   * `retired` 的处置完全不同（前者改模型名、后者删 `extraFreeIds` 条目）。
   */
  it("按 reason × protocol × model × day 累加", () => {
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "gpt-4", at: T0 });
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "gpt-4", at: T0 + 1 });
    stats.recordRejection({ reason: "retired", protocol: "chat", model: "glm-5-free", at: T0 });

    const rows = stats.rejections();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ reason: "not_free", protocol: "chat", model: "gpt-4", count: 2 });
    expect(stats.rejectionsByReason()).toEqual({ not_free: 2, retired: 1 });
  });

  it("not_free 与 retired 分开计数 —— 处置完全不同", () => {
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "a", at: T0 });
    stats.recordRejection({ reason: "retired", protocol: "chat", model: "b", at: T0 });
    const byReason = stats.rejectionsByReason();
    // 合成一类的话「该改文档还是该改配置」就没有答案了。
    expect(byReason["not_free"]).toBe(1);
    expect(byReason["retired"]).toBe(1);
  });

  it("model 为 null（体还没解析出来）时记占位符", () => {
    stats.recordRejection({ reason: "body_not_json", protocol: "chat", model: null, at: T0 });
    expect(stats.rejections()[0]?.model).toBe(UNKNOWN_MODEL);
  });

  /*
   * 这张表的主键**含客户端可控字符串**，而被拒请求里的 `model` 恰好是
   * 没通过任何校验的那个 —— 不归一化就是一个写放大原语。
   * `model_usage` 靠免费闸门挡住了这件事，这张表没有那道闸门。
   */
  it("畸形 model 被归一化 —— 不让客户端任意扩张主键基数", () => {
    for (const bad of [
      "x".repeat(200),
      "evil‮model",
      "a b",
      "has space",
      "semi;colon",
      "",
    ]) {
      stats.recordRejection({ reason: "not_free", protocol: "chat", model: bad, at: T0 });
    }
    // 六个畸形值全部折叠成一行占位符。
    const rows = stats.rejections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: UNKNOWN_MODEL, count: 6 });
  });

  it("形似模型 id 的值保留原样 —— 归一化不过度", () => {
    for (const ok of ["mimo-v2.6-flash-free", "big-pickle", "gpt-4.1_turbo"]) {
      stats.recordRejection({ reason: "not_free", protocol: "chat", model: ok, at: T0 });
    }
    expect(stats.rejections().map((r) => r.model).sort()).toEqual([
      "big-pickle",
      "gpt-4.1_turbo",
      "mimo-v2.6-flash-free",
    ]);
  });

  it("sinceDay 过滤", () => {
    const nextDay = T0 + 24 * 3_600_000;
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "a", at: T0 });
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "a", at: nextDay });
    expect(stats.rejections()[0]?.count).toBe(2);
    expect(stats.rejections(dayKey(nextDay))[0]?.count).toBe(1);
  });
});

describe("「我们自己丢了用量」与「上游没报」分开", () => {
  /*
   * `createUsageCollector.dropped()` 的文档明写这两者必须分开，否则
   * 「覆盖率会把我们自己丢的计成上游没报的」—— 所以不能只看 `totals`。
   *
   * 处置方向相反：dropped 非 0 说明**我们的界定常量**要看（改代码），
   * without 是上游的性质（不用改）。
   */
  it("dropped 进独立计数，不进 without", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null, dropped: true });

    const row = stats.modelUsage()[0];
    expect(row).toMatchObject({
      requestsWithUsage: 0,
      // 关键：**不**计进 without —— 我们根本不知道上游有没有报。
      requestsWithoutUsage: 0,
      requestsDroppedUsage: 1,
    });
  });

  it("上游没报仍进 without", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null, dropped: false });
    expect(stats.modelUsage()[0]).toMatchObject({
      requestsWithoutUsage: 1,
      requestsDroppedUsage: 0,
    });
  });

  it("dropped 算进覆盖率的分母 —— 那些请求确实发生过", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null, dropped: true });

    // 把 dropped 从分母去掉会得到 1.0（虚高），与「不记 without」同一个错误。
    expect(stats.rates().usageCoverage).toBe(0.5);
    // 且它单独可见 —— 非 0 说明要看我们的界定常量。
    expect(stats.rates().droppedUsageCount).toBe(1);
  });

  it("三个计数互斥", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: null, dropped: true });

    expect(stats.modelUsage()[0]).toMatchObject({
      requestsWithUsage: 1,
      requestsWithoutUsage: 1,
      requestsDroppedUsage: 1,
    });
  });
});

describe("明细表的保留期", () => {
  /*
   * `upstream_attempts` 与 `probe_results` 的每行带毫秒级时间戳 ——
   * 合起来是一份作息时间线，在「意外把文件复制出去」这个威胁下比聚合值
   * 敏感得多。聚合所需的信息已在按天的两张表里，所以删明细不损失统计能力。
   */
  it("只删早于 cutoff 的明细，聚合表不动", () => {
    const old = T0 - 40 * 24 * 3_600_000;
    for (const [at, req] of [[old, "旧"], [T0, "新"]] as Array<[number, string]>) {
      stats.recordAttempt({
        requestId: req,
        attemptIndex: 0,
        workerId: "w1",
        protocol: "chat",
        model: "m",
        status: 200,
        failureKind: null,
        latencyMs: 1,
        at,
      });
    }
    stats.recordProbe({ proxyId: "p1", at: old, ok: true, egressIp: "1.2.3.4", latencyMs: 5, failureKind: null });
    stats.recordUsage({ model: "m", workerId: "w1", at: old, usage: usage() });

    const removed = stats.pruneDetailsBefore(T0 - 24 * 3_600_000);
    expect(removed).toBe(2); // 旧 attempt + 旧 probe

    expect(stats.recentAttempts().map((r) => r.requestId)).toEqual(["新"]);
    // worker_stats 与 model_usage 是按天聚合的，不受影响 —— 那正是分开存的理由。
    expect(stats.workerTotals()[0]?.attempts).toBe(2);
    expect(stats.modelUsage()[0]?.requestsWithUsage).toBe(1);
  });

  it("没有过期行时删 0 条，不报错", () => {
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
    });
    expect(stats.pruneDetailsBefore(T0 - 1_000)).toBe(0);
    expect(stats.recentAttempts()).toHaveLength(1);
  });
});

describe("recordProbe", () => {
  /*
   * 这条 SQL 要真执行一次 —— 否则参数顺序与列名都未经验证。
   * 与两张亲和表是同一个陷阱（「CHECK 在生产路径上一次都没
   * 执行过」），`probe_results` 也要真跑。
   */
  it("成功的探测写下 egressIp 与耗时", () => {
    stats.recordProbe({
      proxyId: "node-us",
      at: T0,
      ok: true,
      egressIp: "203.0.113.7",
      latencyMs: 142,
      failureKind: null,
    });
    const row = db.prepare("SELECT * FROM probe_results").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      proxy_id: "node-us",
      at: T0,
      ok: 1,
      egress_ip: "203.0.113.7",
      latency_ms: 142,
      failure_kind: null,
    });
  });

  it("失败的探测 ok=0 且 egressIp 为 null", () => {
    stats.recordProbe({
      proxyId: "node-jp",
      at: T0,
      ok: false,
      egressIp: null,
      latencyMs: null,
      failureKind: "transport",
    });
    expect(db.prepare("SELECT ok, egress_ip, failure_kind FROM probe_results").get()).toEqual({
      ok: 0,
      egress_ip: null,
      failure_kind: "transport",
    });
  });

  it("ok 的 CHECK 只接受 0/1 —— schema 约束真的生效", () => {
    // 直接打 SQL（绕过布尔转换）验 CHECK 存在。
    expect(() =>
      db.prepare("INSERT INTO probe_results (proxy_id, at, ok) VALUES (?, ?, ?)").run("p", 1, 7),
    ).toThrow(/CHECK/);
  });
});

describe("daily：按天的 token 序列（用量图表）", () => {
  it("按天 × 模型分组；会话只算保留的那条，请求数逐条累计", () => {
    const nextDay = T0 + 24 * 3_600_000;
    stats.recordUsage({ model: "a", workerId: "w1", at: T0, usage: usage({ promptTokens: 100 }) });
    stats.recordUsage({ model: "a", workerId: "w2", at: T0, usage: usage({ promptTokens: 1_000 }), sessionHash: "s1" });
    stats.recordUsage({ model: "a", workerId: "w2", at: T0 + 1, usage: usage({ promptTokens: 3_000 }), sessionHash: "s1" });
    stats.recordUsage({ model: "b", workerId: "w1", at: nextDay, usage: usage({ promptTokens: 7 }) });

    expect(stats.daily().byModel).toEqual([
      { day: dayKey(T0), key: "a", inputTokens: 3_100, outputTokens: 40, cacheReadTokens: 0, requests: 3 },
      { day: dayKey(nextDay), key: "b", inputTokens: 7, outputTokens: 20, cacheReadTokens: 0, requests: 1 },
    ]);
    // 与 modelUsage 同一口径 —— 图表和表格的合计必须一致。
    const sum = stats.daily().byModel.reduce((n, r) => n + r.inputTokens, 0);
    expect(sum).toBe(stats.modelUsage().reduce((n, r) => n + r.inputTokens, 0));
  });

  it("按 Worker 分组，sinceDay 两个子查询都生效", () => {
    const nextDay = T0 + 24 * 3_600_000;
    stats.recordUsage({ model: "a", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "a", workerId: "w1", at: T0, usage: usage(), sessionHash: "s-old" });
    stats.recordUsage({ model: "a", workerId: "w2", at: nextDay, usage: usage(), sessionHash: "s-new" });
    expect(stats.daily().byWorker.map((r) => [r.day, r.key])).toEqual([
      [dayKey(T0), "w1"],
      [dayKey(nextDay), "w2"],
    ]);
    expect(stats.daily(dayKey(nextDay)).byWorker.map((r) => r.key)).toEqual(["w2"]);
  });
});

describe("reset：清空用量，保留调度状态", () => {
  it("清空五张用量表并返回行数；探测历史与会话亲和不动", () => {
    stats.recordAttempt({ requestId: "r", attemptIndex: 0, workerId: "w1", protocol: "chat", model: "m", status: 200, failureKind: null, latencyMs: 1, at: T0 });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage(), sessionHash: "s1" });
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "x", at: T0 });
    stats.recordProbe({ proxyId: "p", at: T0, ok: true, egressIp: "203.0.113.7", latencyMs: 1, failureKind: null });
    db.prepare("INSERT INTO session_affinity (session_hash, worker_id, bound_at, expires_at) VALUES (?, ?, ?, ?)").run("a".repeat(64), "w1", T0, T0 + 1);

    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const usageTables = ["upstream_attempts", "model_usage", "session_usage", "worker_stats", "gateway_rejections"];
    const before = usageTables.reduce((n, t) => n + count(t), 0);
    expect(usageTables.every((t) => count(t) > 0)).toBe(true);

    expect(stats.reset()).toBe(before);
    expect(usageTables.map(count)).toEqual([0, 0, 0, 0, 0]);
    expect(stats.modelUsage()).toEqual([]);
    expect(stats.requestCounts()).toEqual({ requests: 0, attempts: 0 });
    expect(count("probe_results")).toBe(1);
    expect(count("session_affinity")).toBe(1);
  });

  it("失败时回滚：要么全清，要么都不动", () => {
    stats.recordUsage({ model: "m", workerId: "w1", at: T0, usage: usage() });
    // 让最后一张表的 DELETE 失败，前面已删的表必须被回滚。
    db.exec("CREATE TRIGGER block_reset BEFORE DELETE ON gateway_rejections BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    stats.recordRejection({ reason: "not_free", protocol: "chat", model: "x", at: T0 });
    expect(() => stats.reset()).toThrow(/blocked/);
    expect(stats.modelUsage()).toHaveLength(1);
  });
});
