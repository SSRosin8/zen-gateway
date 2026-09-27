import type { DatabaseSync, StatementSync } from "node:sqlite";
import { WriteFailures } from "./writeFailures.ts";
import type { TokenUsage } from "../../core/models/usage.ts";
import { UNKNOWN_MODEL } from "../../shared/contract.ts";

/**
 * 统计的写入与聚合。
 *
 * 客户端请求 ≠ 上游尝试：`upstream_attempts` 按尝试写行，`request_id` 串起重试链。
 * 缺失的 usage 如实计为缺失，不估算。写入全部走 `WriteFailures.guard()` 吞异常并计数，
 * 统计失败不影响转发但可诊断。
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
  /** null 表示这次请求没拿到用量，具体是哪种由 `dropped` 区分。 */
  readonly usage: TokenUsage | null;
  /**
   * 网关自己没能完整解析（响应过大／中途断流），而不是上游没报。两者处置方向相反，
   * 必须分开计，见 `createUsageCollector.dropped()`。
   */
  readonly dropped?: boolean;
  /**
   * 客户端会话标识的摘要；null/缺省表示没有会话标识。带会话的请求每次上报的是整段对话
   * 到此为止的用量，token 按 (会话, 模型) 只保留最大的一条，不逐条相加。
   */
  readonly sessionHash?: string | null;
};

/** 网关自己拒掉一次请求的原因。取值与 `judgeFree` 的 reason 同源，外加请求体层的几类。 */
export type RejectionReason =
  | "not_free"
  | "retired"
  | "body_unreadable"
  | "body_too_large"
  | "body_empty"
  | "body_not_json"
  | "model_missing"
  | "stream_unsupported"
  | "no_worker";

export type RejectionRow = {
  readonly reason: RejectionReason;
  readonly protocol: string;
  /** 客户端可控；进库前必须过 `normalizeRejectionModel`。 */
  readonly model: string | null;
  readonly at: number;
};

export type RejectionTotals = {
  readonly reason: string;
  readonly protocol: string;
  readonly model: string;
  readonly count: number;
};

export type ModelUsageTotals = {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly requestsWithUsage: number;
  readonly requestsWithoutUsage: number;
  /** 网关自己没解析完整的次数，见 `UsageRow.dropped`。 */
  readonly requestsDroppedUsage: number;
};

export type WorkerTotals = {
  readonly workerId: string;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastUsedAt: number | null;
  readonly lastStatus: number | null;
};

/** 派生比值。分母为 0 时给 null 而不是 0：「没有数据」与「0%」要区分。 */
export type DerivedRates = {
  /** 命中读 ÷ 总输入。null = 还没有带 usage 的请求。 */
  readonly cacheHitRate: number | null;
  /** 带 usage 的请求 ÷ 全部请求（分母含 dropped）。null = 还没有任何请求。 */
  readonly usageCoverage: number | null;
  /** 网关自己没解析完整的次数。非 0 说明要看界定常量，不是上游的问题。 */
  readonly droppedUsageCount: number;
};

/**
 * 聚合饱和上界。越过 `MAX_SAFE_INTEGER` 时读出会抛，int64 的 `SUM()` 也会溢出抛错，
 * 所以在 SQL 里用 `total()`（恒为 REAL，不溢出）再 `MIN` 夹住并转回整数。
 * 与 `usage.ts` 的 `clampTokens` 同一策略。
 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** 累加并饱和到 `MAX_SAFE` 的 SQL 片段，各聚合共用（纪律 #4）。 */
function saturatingSum(column: string): string {
  return `CAST(MIN(total(${column}), ${MAX_SAFE}) AS INTEGER)`;
}

/**
 * 两张用量表合成同一形状：`model_usage`（无会话请求的 token + 全部请求计数）与
 * `session_usage`（每段会话最大的一条 token）。`filtered` 时两处各占一个 `day >= ?` 参数。
 */
function usageUnion(filtered: boolean): string {
  const where = filtered ? "WHERE day >= ?" : "";
  return `
    SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           requests_with_usage, requests_without_usage, requests_dropped_usage
    FROM model_usage ${where}
    UNION ALL
    SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, 0, 0, 0
    FROM session_usage ${where}
  `;
}

/** UTC 日期键。`day` 是主键的一部分，本地时区会随夏令时或迁移让同一天分裂。 */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** `gateway_rejections.model` 的占位符：客户端给的值不像模型 id 时用它。 */
export { UNKNOWN_MODEL };

/**
 * 把被拒请求里的 `model` 归一化后才允许进库：主键含客户端可控且未过校验的字符串，
 * 不归一化就是写放大原语。形似模型 id 时保留原值，否则记 `<other>`。
 */
export function normalizeRejectionModel(model: string | null): string {
  if (model === null || model === "") return UNKNOWN_MODEL;
  return /^[A-Za-z0-9._-]{1,64}$/.test(model) ? model : UNKNOWN_MODEL;
}

export class StatsStore {
  #db: DatabaseSync;
  #writes = new WriteFailures();

  // 预编译语句：热路径每请求都要用。
  #insertAttempt: StatementSync;
  #upsertWorker: StatementSync;
  #upsertUsage: StatementSync;
  #insertProbe: StatementSync;
  #upsertRejection: StatementSync;
  #upsertSessionUsage: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;

    this.#insertAttempt = db.prepare(`
      INSERT INTO upstream_attempts
        (request_id, attempt_index, worker_id, protocol, model, status, failure_kind, latency_ms, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 累计计数用 upsert 而非先查后写，避免丢更新；`last_used_at` 含失败的那次。
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

    // token 累加在写入侧夹上界：单次已由 `clampTokens` 夹过，但累加会溢出 INTEGER 列。
    this.#upsertUsage = db.prepare(`
      INSERT INTO model_usage (
        model, worker_id, day,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        requests_with_usage, requests_without_usage, requests_dropped_usage
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (model, worker_id, day) DO UPDATE SET
        input_tokens           = MIN(input_tokens + excluded.input_tokens, ${MAX_SAFE}),
        output_tokens          = MIN(output_tokens + excluded.output_tokens, ${MAX_SAFE}),
        cache_read_tokens      = MIN(cache_read_tokens + excluded.cache_read_tokens, ${MAX_SAFE}),
        cache_write_tokens     = MIN(cache_write_tokens + excluded.cache_write_tokens, ${MAX_SAFE}),
        requests_with_usage    = requests_with_usage + excluded.requests_with_usage,
        requests_without_usage = requests_without_usage + excluded.requests_without_usage,
        requests_dropped_usage = requests_dropped_usage + excluded.requests_dropped_usage
    `);

    /*
     * 不累加：同一会话的后一条已包含前一条的上下文。取「最大的那条」而不是「最后到达的那条」：
     * 客户端会用同一会话头发标题生成这类小请求，它可能晚于主请求结束，按到达顺序覆盖会把
     * 整段会话记成那个小请求。上下文压缩后的小值因此不会替换峰值，只会让数字略偏大。
     */
    this.#upsertSessionUsage = db.prepare(`
      INSERT INTO session_usage (
        session_hash, model, worker_id, day,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_hash, model) DO UPDATE SET
        worker_id          = excluded.worker_id,
        day                = excluded.day,
        input_tokens       = excluded.input_tokens,
        output_tokens      = excluded.output_tokens,
        cache_read_tokens  = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens
      WHERE excluded.input_tokens + excluded.output_tokens
         >= session_usage.input_tokens + session_usage.output_tokens
    `);

    this.#insertProbe = db.prepare(`
      INSERT INTO probe_results (proxy_id, at, ok, egress_ip, latency_ms, failure_kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.#upsertRejection = db.prepare(`
      INSERT INTO gateway_rejections (reason, protocol, model, day, count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (reason, protocol, model, day) DO UPDATE SET count = count + 1
    `);
  }

  /** 统计写入失败的次数，经 `/health` 的 `storeWriteFailures` 暴露。 */
  writeFailures(): { count: number; lastError: string | null } {
    return this.#writes.snapshot();
  }

  /** 记一次上游尝试，并同步更新该 Worker 的累计计数。 */
  recordAttempt(row: AttemptRow): void {
    this.#writes.guard("recordAttempt", () => {
      const success = row.failureKind === null;
      // 明细与累计同一事务，保持一致。
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
   * 记一次请求的用量。`usage` 为 null 时也要计数，否则覆盖率分母会漏掉这次请求。
   * 带会话的请求 token 进 `session_usage`（每段会话一条），`model_usage` 只记它的请求计数。
   */
  recordUsage(row: UsageRow): void {
    this.#writes.guard("recordUsage", () => {
      const u = row.usage;
      const dropped = row.dropped === true;
      const day = dayKey(row.at);
      const session = row.sessionHash ?? null;
      const summed = session === null ? u : null;
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        // 三个计数互斥：拿到了 / 网关丢了 / 上游没报。`dropped` 优先：此时无从得知上游报没报。
        this.#upsertUsage.run(
          row.model,
          row.workerId,
          day,
          summed?.promptTokens ?? 0,
          summed?.completionTokens ?? 0,
          summed?.cacheReadTokens ?? 0,
          summed?.cacheWriteTokens ?? 0,
          u === null ? 0 : 1,
          u === null && !dropped ? 1 : 0,
          dropped ? 1 : 0,
        );
        // 没拿到用量时保留上一条：它仍是这段会话已知的最新用量。
        if (session !== null && u !== null) {
          this.#upsertSessionUsage.run(
            session,
            row.model,
            row.workerId,
            day,
            u.promptTokens,
            u.completionTokens,
            u.cacheReadTokens,
            u.cacheWriteTokens,
          );
        }
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /** 记一次网关自己的拒绝（请求从未到达上游），与 `recordAttempt` 严格分开。 */
  recordRejection(row: RejectionRow): void {
    this.#writes.guard("recordRejection", () => {
      this.#upsertRejection.run(
        row.reason,
        row.protocol,
        normalizeRejectionModel(row.model),
        dayKey(row.at),
      );
    });
  }

  /** 记一次出口探测。生产调用点是汇合点 `EgressService.probeProxy`，`probeAll` 也经它。 */
  recordProbe(row: {
    proxyId: string;
    at: number;
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    failureKind: string | null;
  }): void {
    this.#writes.guard("recordProbe", () => {
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

  /**
   * per-model token 汇总。`sinceDay` 为 UTC 日期键（含当天）。会话用量按保留那条所在的天
   * 归入时间窗：它代表整段会话，拆到每天会重复计算。
   */
  modelUsage(sinceDay?: string): ModelUsageTotals[] {
    const stmt = this.#db.prepare(`
      SELECT
        model,
        ${saturatingSum("input_tokens")} AS input_tokens,
        ${saturatingSum("output_tokens")} AS output_tokens,
        ${saturatingSum("cache_read_tokens")} AS cache_read_tokens,
        ${saturatingSum("cache_write_tokens")} AS cache_write_tokens,
        ${saturatingSum("requests_with_usage")} AS requests_with_usage,
        ${saturatingSum("requests_without_usage")} AS requests_without_usage,
        ${saturatingSum("requests_dropped_usage")} AS requests_dropped_usage
      FROM (${usageUnion(sinceDay !== undefined)})
      GROUP BY model
      ORDER BY input_tokens + output_tokens DESC, model ASC
    `);
    const rows = (sinceDay === undefined ? stmt.all() : stmt.all(sinceDay, sinceDay)) as Array<
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
      requestsDroppedUsage: r["requests_dropped_usage"] as number,
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

  /** 派生比值。缓存命中率分母是总输入：上游把命中缓存的 token 计在 prompt 里。 */
  rates(sinceDay?: string): DerivedRates {
    const stmt = this.#db.prepare(`
      SELECT
        ${saturatingSum("input_tokens")} AS input_tokens,
        ${saturatingSum("cache_read_tokens")} AS cache_read_tokens,
        ${saturatingSum("requests_with_usage")} AS with_usage,
        ${saturatingSum("requests_without_usage")} AS without_usage,
        ${saturatingSum("requests_dropped_usage")} AS dropped_usage
      FROM (${usageUnion(sinceDay !== undefined)})
    `);
    const row = (sinceDay === undefined ? stmt.get() : stmt.get(sinceDay, sinceDay)) as
      | Record<string, number | null>
      | undefined;

    const input = row?.["input_tokens"] ?? 0;
    const cacheRead = row?.["cache_read_tokens"] ?? 0;
    const withUsage = row?.["with_usage"] ?? 0;
    const withoutUsage = row?.["without_usage"] ?? 0;
    const droppedUsage = row?.["dropped_usage"] ?? 0;
    // 分母含 dropped：那些请求确实发生过，去掉会让覆盖率虚高。
    const total = withUsage + withoutUsage + droppedUsage;

    return {
      cacheHitRate: input === 0 ? null : cacheRead / input,
      usageCoverage: total === 0 ? null : withUsage / total,
      droppedUsageCount: droppedUsage,
    };
  }

  /** 网关拒绝的按天聚合。 */
  rejections(sinceDay?: string): RejectionTotals[] {
    const where = sinceDay === undefined ? "" : "WHERE day >= ?";
    const stmt = this.#db.prepare(`
      SELECT reason, protocol, model,
             ${saturatingSum("count")} AS count
      FROM gateway_rejections
      ${where}
      GROUP BY reason, protocol, model
      ORDER BY count DESC, reason ASC, model ASC
    `);
    const rows = (sinceDay === undefined ? stmt.all() : stmt.all(sinceDay)) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      reason: r["reason"] as string,
      protocol: r["protocol"] as string,
      model: r["model"] as string,
      count: r["count"] as number,
    }));
  }

  /** 拒绝总数，按 reason 汇总（不分协议面与模型）。 */
  rejectionsByReason(sinceDay?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.rejections(sinceDay)) {
      out[row.reason] = (out[row.reason] ?? 0) + row.count;
    }
    return out;
  }

  /** 被拒的模型名与原因（不分协议面）。模型名已在写入时归一化，见 `normalizeRejectionModel`。 */
  rejectedModels(sinceDay?: string): Array<{ reason: string; model: string; count: number }> {
    const merged = new Map<string, { reason: string; model: string; count: number }>();
    for (const row of this.rejections(sinceDay)) {
      const key = `${row.reason} ${row.model}`;
      const prev = merged.get(key);
      if (prev === undefined) merged.set(key, { reason: row.reason, model: row.model, count: row.count });
      else prev.count += row.count;
    }
    return [...merged.values()].sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  }

  /** 请求数与尝试数：一条重试链是一个请求、多次尝试，`DISTINCT request_id` 数前者。 */
  requestCounts(sinceDay?: string): { requests: number; attempts: number } {
    // 唯一随行数线性变慢的同步聚合（全表扫会阻塞事件循环），管理 API 应总是传 `sinceDay`。
    const where = sinceDay === undefined ? "" : "WHERE at >= ?";
    const stmt = this.#db.prepare(
      `SELECT COUNT(DISTINCT request_id) AS requests, COUNT(*) AS attempts
       FROM upstream_attempts ${where}`,
    );
    const row = (
      sinceDay === undefined ? stmt.get() : stmt.get(Date.parse(`${sinceDay}T00:00:00Z`))
    ) as { requests: number; attempts: number } | undefined;
    return { requests: row?.requests ?? 0, attempts: row?.attempts ?? 0 };
  }

  /**
   * 删掉早于 `before` 的明细行（`upstream_attempts` 与带 `egress_ip` 的 `probe_results`），
   * 返回删除条数。明细是敏感的作息时间线；聚合表已保留统计所需信息。
   */
  pruneDetailsBefore(before: number): number {
    let removed = 0;
    this.#writes.guard("pruneDetailsBefore", () => {
      const a = this.#db.prepare("DELETE FROM upstream_attempts WHERE at < ?").run(before);
      const b = this.#db.prepare("DELETE FROM probe_results WHERE at < ?").run(before);
      removed = Number(a.changes) + Number(b.changes);
    });
    return removed;
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
