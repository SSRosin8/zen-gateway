import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { TokenUsage } from "../../core/models/usage.ts";

/**
 * 统计的写入与聚合。
 *
 * ## 这一层的语义边界（Phase 7 最容易搞错的地方）
 *
 * **客户端请求 ≠ 上游尝试。** 一条 `w1 限流 → w2 成功` 的重试链是
 * **一个**客户端请求、**两次**上游尝试。两个数字都要能查到，而且每次尝试
 * 都必须在对应 Worker 上可见 —— 否则「这个 Worker 到底转发过什么」无从查证。
 * 因此 `upstream_attempts` 按尝试写行，`request_id` 把同一条链串起来。
 *
 * **缺失的 usage 如实显示为缺失，不估算。** `model_usage` 把
 * `requests_with_usage` 与 `requests_without_usage` 分开计数，聚合时据此算
 * 覆盖率。免费模型的响应未必带 usage，若把没报的按均值补上，
 * 「缓存命中率」这类比值会凭空变好看 —— 那比没有数字更糟。
 *
 * ## 写入失败不影响转发
 *
 * 统计是**诊断设施**，不是正确性的一部分。磁盘满、库被锁、schema 不匹配
 * 都不该让一个本来会成功的转发失败。所以写入全部走 `#safe()` 吞异常并计数，
 * 由 `writeFailures()` 暴露 —— **吞掉但可观测**，而不是静默。
 * 这与 relay.ts 的 `onDone` 顺序规则同源：诊断动作不得伤及主路径。
 */

/** 一次上游尝试。与 `AttemptRecord` 不同：这里是「已发生的事实」，含耗时与状态码。 */
export type AttemptRow = {
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly workerId: string;
  readonly protocol: string;
  readonly model: string | null;
  readonly status: number | null;
  readonly failureKind: string | null;
  readonly latencyMs: number | null;
  readonly at: number;
};

export type UsageRow = {
  readonly model: string;
  readonly workerId: string;
  readonly at: number;
  /** null 表示这次请求上游没报用量 —— 记进 requests_without_usage。 */
  readonly usage: TokenUsage | null;
};

export type ModelUsageTotals = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly requestsWithUsage: number;
  readonly requestsWithoutUsage: number;
};

export type WorkerTotals = {
  readonly workerId: string;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastUsedAt: number | null;
  readonly lastStatus: number | null;
};

/**
 * 派生比值。**分母为 0 时给 null 而不是 0** ——
 * 「没有数据」和「命中率是 0%」是两件完全不同的事，
 * 前者要在 UI 上显示为「—」，后者是一个需要排查的真实数字。
 */
export type DerivedRates = {
  /** 命中读 ÷ 总输入。null = 还没有带 usage 的请求。 */
  readonly cacheHitRate: number | null;
  /** 带 usage 的请求 ÷ 全部请求。null = 还没有任何请求。 */
  readonly usageCoverage: number | null;
};

/**
 * SQLite 的 `SUM()` 越过 `Number.MAX_SAFE_INTEGER` 时**会抛**
 * （实测：`Value is too large to be represented as a JavaScript number`）——
 * 不是静默失真，是整个查询失败。于是一个跑久了的库会让统计页直接报错。
 *
 * 在 SQL 里用 `MIN(SUM(...), ?)` 夹住，与 `usage.ts` 的 `clampTokens`
 * 同一个策略（那里也是「宁可饱和，不要溢出」）。放在 SQL 而不是读出来再夹：
 * 读出来那一步就已经抛了。
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * UTC 日期键。
 *
 * 刻意用 UTC 而不是本地时区：`day` 是主键的一部分，而本地时区会随
 * 夏令时与机器迁移变化 —— 那会让同一天的数据分裂成两行，或让两天并成一行。
 * 单机自用工具里「按 UTC 日聚合」的代价只是跨日边界与直觉差几小时。
 */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class StatsStore {
  #db: DatabaseSync;
  #writeFailures = 0;
  #lastWriteError: string | null = null;

  // 预编译语句。热路径每请求都要用，重复 prepare 是白费的解析开销。
  #insertAttempt: StatementSync;
  #upsertWorker: StatementSync;
  #upsertUsage: StatementSync;
  #insertProbe: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;

    this.#insertAttempt = db.prepare(`
      INSERT INTO upstream_attempts
        (request_id, attempt_index, worker_id, protocol, model, status, failure_kind, latency_ms, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    /*
     * worker_stats 是累计计数，用 upsert 而不是先查后写：
     * 后者在并发下会丢更新（两个请求读到同一个旧值各加一）。
     *
     * `last_status` 允许为 null（传输失败时没有状态码），而 `last_used_at`
     * 无条件更新 —— 「最近一次被用到」包括失败的那次，那正是排查时想知道的。
     */
    this.#upsertWorker = db.prepare(`
      INSERT INTO worker_stats (worker_id, attempts, successes, failures, last_used_at, last_status)
      VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT (worker_id) DO UPDATE SET
        attempts     = attempts + 1,
        successes    = successes + excluded.successes,
        failures     = failures + excluded.failures,
        last_used_at = excluded.last_used_at,
        last_status  = excluded.last_status
    `);

    /*
     * token 累加同样夹上界：单次已由 `clampTokens` 夹过，但**累加会溢出**，
     * 而列是 INTEGER。夹在写入侧，读出来就不会触发 SUM 的抛错。
     */
    this.#upsertUsage = db.prepare(`
      INSERT INTO model_usage (
        model, worker_id, day,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        requests_with_usage, requests_without_usage
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (model, worker_id, day) DO UPDATE SET
        input_tokens           = MIN(input_tokens + excluded.input_tokens, ${MAX_SAFE}),
        output_tokens          = MIN(output_tokens + excluded.output_tokens, ${MAX_SAFE}),
        cache_read_tokens      = MIN(cache_read_tokens + excluded.cache_read_tokens, ${MAX_SAFE}),
        cache_write_tokens     = MIN(cache_write_tokens + excluded.cache_write_tokens, ${MAX_SAFE}),
        requests_with_usage    = requests_with_usage + excluded.requests_with_usage,
        requests_without_usage = requests_without_usage + excluded.requests_without_usage
    `);

    this.#insertProbe = db.prepare(`
      INSERT INTO probe_results (proxy_id, at, ok, egress_ip, latency_ms, failure_kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * 统计写入失败的次数。
   *
   * 吞异常是对的（见类注释），但**吞掉不等于可以不知道** ——
   * 一个一直写失败的统计库会安静地给出全 0 的报表，而那看起来像「没人用」。
   * Phase 8 的 `doctor` 应当报这个数。
   */
  writeFailures(): { count: number; lastError: string | null } {
    return { count: this.#writeFailures, lastError: this.#lastWriteError };
  }

  #safe(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#writeFailures += 1;
      this.#lastWriteError = `${what}: ${err instanceof Error ? err.message : "未知错误"}`;
    }
  }

  /** 记一次上游尝试，并同步更新该 Worker 的累计计数。 */
  recordAttempt(row: AttemptRow): void {
    this.#safe("recordAttempt", () => {
      const success = row.failureKind === null;
      /*
       * 两张表一个事务：`upstream_attempts` 的明细与 `worker_stats` 的累计
       * 必须一致，否则「明细里有 5 次而累计说 4 次」这种偏差查不出根因。
       */
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#insertAttempt.run(
          row.requestId,
          row.attemptIndex,
          row.workerId,
          row.protocol,
          row.model,
          row.status,
          row.failureKind,
          row.latencyMs,
          row.at,
        );
        this.#upsertWorker.run(
          row.workerId,
          success ? 1 : 0,
          success ? 0 : 1,
          row.at,
          row.status,
        );
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /**
   * 记一次请求的用量。`usage` 为 null 时只累加 `requests_without_usage` ——
   * 那一行必须存在，否则覆盖率的分母会漏掉这次请求，显得覆盖率虚高。
   */
  recordUsage(row: UsageRow): void {
    this.#safe("recordUsage", () => {
      const u = row.usage;
      this.#upsertUsage.run(
        row.model,
        row.workerId,
        dayKey(row.at),
        u?.promptTokens ?? 0,
        u?.completionTokens ?? 0,
        u?.cacheReadTokens ?? 0,
        u?.cacheWriteTokens ?? 0,
        u === null ? 0 : 1,
        u === null ? 1 : 0,
      );
    });
  }

  recordProbe(row: {
    proxyId: string;
    at: number;
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    failureKind: string | null;
  }): void {
    this.#safe("recordProbe", () => {
      this.#insertProbe.run(
        row.proxyId,
        row.at,
        row.ok ? 1 : 0,
        row.egressIp,
        row.latencyMs,
        row.failureKind,
      );
    });
  }

  /* ---------------- 聚合查询 ---------------- */

  /** per-model token 汇总。`sinceDay` 为 UTC 日期键（含当天）。 */
  modelUsage(sinceDay?: string): ModelUsageTotals[] {
    const where = sinceDay === undefined ? "" : "WHERE day >= ?";
    const stmt = this.#db.prepare(`
      SELECT
        model,
        MIN(SUM(input_tokens),       ${MAX_SAFE}) AS input_tokens,
        MIN(SUM(output_tokens),      ${MAX_SAFE}) AS output_tokens,
        MIN(SUM(cache_read_tokens),  ${MAX_SAFE}) AS cache_read_tokens,
        MIN(SUM(cache_write_tokens), ${MAX_SAFE}) AS cache_write_tokens,
        MIN(SUM(requests_with_usage),    ${MAX_SAFE}) AS requests_with_usage,
        MIN(SUM(requests_without_usage), ${MAX_SAFE}) AS requests_without_usage
      FROM model_usage
      ${where}
      GROUP BY model
      ORDER BY input_tokens + output_tokens DESC, model ASC
    `);
    const rows = (sinceDay === undefined ? stmt.all() : stmt.all(sinceDay)) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      model: r["model"] as string,
      inputTokens: r["input_tokens"] as number,
      outputTokens: r["output_tokens"] as number,
      cacheReadTokens: r["cache_read_tokens"] as number,
      cacheWriteTokens: r["cache_write_tokens"] as number,
      requestsWithUsage: r["requests_with_usage"] as number,
      requestsWithoutUsage: r["requests_without_usage"] as number,
    }));
  }

  /** Worker 累计计数。 */
  workerTotals(): WorkerTotals[] {
    const rows = this.#db
      .prepare(
        `SELECT worker_id, attempts, successes, failures, last_used_at, last_status
         FROM worker_stats ORDER BY attempts DESC, worker_id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      workerId: r["worker_id"] as string,
      attempts: r["attempts"] as number,
      successes: r["successes"] as number,
      failures: r["failures"] as number,
      lastUsedAt: (r["last_used_at"] as number | null) ?? null,
      lastStatus: (r["last_status"] as number | null) ?? null,
    }));
  }

  /**
   * 派生比值。
   *
   * **缓存命中率的分母是「总输入」而不是「prompt - cacheRead」**：
   * 上游把命中缓存的 token 计在 prompt 里，所以 `cacheRead / prompt`
   * 才是命中比例。用 `prompt - cacheRead` 当分母会在全命中时除以 0。
   */
  rates(sinceDay?: string): DerivedRates {
    const where = sinceDay === undefined ? "" : "WHERE day >= ?";
    const stmt = this.#db.prepare(`
      SELECT
        MIN(SUM(input_tokens),      ${MAX_SAFE}) AS input_tokens,
        MIN(SUM(cache_read_tokens), ${MAX_SAFE}) AS cache_read_tokens,
        MIN(SUM(requests_with_usage),    ${MAX_SAFE}) AS with_usage,
        MIN(SUM(requests_without_usage), ${MAX_SAFE}) AS without_usage
      FROM model_usage
      ${where}
    `);
    const row = (sinceDay === undefined ? stmt.get() : stmt.get(sinceDay)) as
      | Record<string, number | null>
      | undefined;

    const input = row?.["input_tokens"] ?? 0;
    const cacheRead = row?.["cache_read_tokens"] ?? 0;
    const withUsage = row?.["with_usage"] ?? 0;
    const withoutUsage = row?.["without_usage"] ?? 0;
    const total = withUsage + withoutUsage;

    return {
      // 分母为 0 → null。见 DerivedRates 的说明。
      cacheHitRate: input === 0 ? null : cacheRead / input,
      usageCoverage: total === 0 ? null : withUsage / total,
    };
  }

  /**
   * 请求数与尝试数。
   *
   * 这两个数字**必须分开**，它们是本页最容易被当成同一个的量：
   * 一条重试链是一个请求、多次尝试。`DISTINCT request_id` 数前者。
   */
  requestCounts(): { requests: number; attempts: number } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT request_id) AS requests, COUNT(*) AS attempts
         FROM upstream_attempts`,
      )
      .get() as { requests: number; attempts: number } | undefined;
    return { requests: row?.requests ?? 0, attempts: row?.attempts ?? 0 };
  }

  /** 最近的上游尝试，供排查用。 */
  recentAttempts(limit = 50): AttemptRow[] {
    const rows = this.#db
      .prepare(
        `SELECT request_id, attempt_index, worker_id, protocol, model, status,
                failure_kind, latency_ms, at
         FROM upstream_attempts ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      requestId: r["request_id"] as string,
      attemptIndex: r["attempt_index"] as number,
      workerId: r["worker_id"] as string,
      protocol: r["protocol"] as string,
      model: (r["model"] as string | null) ?? null,
      status: (r["status"] as number | null) ?? null,
      failureKind: (r["failure_kind"] as string | null) ?? null,
      latencyMs: (r["latency_ms"] as number | null) ?? null,
      at: r["at"] as number,
    }));
  }
}
