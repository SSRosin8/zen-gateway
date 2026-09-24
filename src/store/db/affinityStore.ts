import type { DatabaseSync, StatementSync } from "node:sqlite";
/*
 * 容量上限从 `affinity.ts` 取，不在这里另写一个数字（纪律 #4）——
 * 两份必然分叉，而分叉方向是「DB 装回来的比内存上限多」。
 */
import { BLOB_CAP, SESSION_CAP } from "../../core/routing/affinity.ts";

/**
 * 会话/指纹亲和的持久化。
 *
 * ## 内存是唯一真相，这里只是镜像
 *
 * `AffinityMap` 仍然是查询路径的唯一来源 —— 转发热路径上**没有** DB 读。
 * 理由是 `node:sqlite` 是**同步** API：把 `lookupSession` 换成查库
 * 等于在每个请求的关键路径上阻塞事件循环，而亲和查询每请求至少一次。
 *
 * 所以分工是：
 *
 * - **启动时**：`load()` 一次性把未过期的绑定读进内存
 * - **写入时**：内存改完顺手镜像到 DB
 * - **查询时**：只读内存，不碰 DB
 *
 * 代价是进程被 `kill -9` 时可能丢掉最后一刻的绑定。可接受 ——
 * 丢一条绑定的后果是那条会话下一轮重挑一次 Worker，不是数据损坏。
 *
 * ## 写失败不影响转发
 *
 * 与 `StatsStore` 同一个判断：持久化是**可用性改善**，不是正确性的一部分。
 * 内存里那份已经生效了，DB 写失败只意味着「重启后会丢」。
 * 所以吞异常但计数（`writeFailures()`），不让它冒泡到请求。
 *
 * ## 为什么不在这里做容量淘汰
 *
 * `AffinityMap` 的 `evict()` 有一条承重规则（先清过期、再 FIFO），
 * 而它是防「灌满表挤掉别人活跃绑定」的。若这里再实现一份淘汰，
 * 两份规则必然脱节 —— 那正是纪律 #4。做法是：内存淘汰后由调用方
 * 把删除也镜像过来（`deleteSession`/`deleteBlobs`），DB 只忠实跟随内存。
 */

export type StoredBinding = {
  readonly hash: string;
  readonly workerId: string;
  /** 绑定/学习的时刻。TTL 由内存侧按 `now - at` 判定，这里只存原值。 */
  readonly at: number;
};

export class AffinityStore {
  #db: DatabaseSync;
  #writeFailures = 0;
  #lastWriteError: string | null = null;

  #putSession: StatementSync;
  #delSession: StatementSync;
  #putBlob: StatementSync;
  #delBlob: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;

    /*
     * `expires_at` 是**派生列**：由 `at + ttlMs` 算出来存进去，只用于
     * 「启动时筛掉已过期的」与索引。TTL 的权威判定仍在内存侧的 `fresh()`
     * —— 那里还额外处理了「绑定来自未来」（时钟回拨）这一情况。
     *
     * 存派生值而不是每次查询时算：`idx_session_expires` 要用它，
     * 而 SQLite 的表达式索引在这里不值得。
     */
    this.#putSession = db.prepare(`
      INSERT INTO session_affinity (session_hash, worker_id, bound_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (session_hash) DO UPDATE SET
        worker_id  = excluded.worker_id,
        bound_at   = excluded.bound_at,
        expires_at = excluded.expires_at
    `);
    this.#delSession = db.prepare("DELETE FROM session_affinity WHERE session_hash = ?");

    this.#putBlob = db.prepare(`
      INSERT INTO blob_affinity (blob_hash, worker_id, learned_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (blob_hash) DO UPDATE SET
        worker_id  = excluded.worker_id,
        learned_at = excluded.learned_at,
        expires_at = excluded.expires_at
    `);
    this.#delBlob = db.prepare("DELETE FROM blob_affinity WHERE blob_hash = ?");
  }

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

  putSession(hash: string, workerId: string, at: number, ttlMs: number): void {
    this.#safe("putSession", () => {
      this.#putSession.run(hash, workerId, at, at + ttlMs);
    });
  }

  deleteSession(hash: string): void {
    this.#safe("deleteSession", () => {
      this.#delSession.run(hash);
    });
  }

  /** 批量学习指纹。一个事务 —— 一次请求可学多个，逐条提交是白费的 fsync。 */
  putBlobs(hashes: readonly string[], workerId: string, at: number, ttlMs: number): void {
    if (hashes.length === 0) return;
    this.#safe("putBlobs", () => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        for (const hash of hashes) this.#putBlob.run(hash, workerId, at, at + ttlMs);
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  deleteBlobs(hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    this.#safe("deleteBlobs", () => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        for (const hash of hashes) this.#delBlob.run(hash);
        this.#db.exec("COMMIT");
      } catch (err) {
        this.#db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  /**
   * 读出用于恢复内存的绑定。
   *
   * 按 `bound_at` **升序**返回：内存侧的 `Map` 按插入顺序迭代，而 FIFO
   * 淘汰淘的是最老的。若这里乱序返回，重启后「最老的那个」就不再是真的最老，
   * 于是淘汰会挑错对象 —— 一个只在重启后出现、且完全不报错的行为偏差。
   *
   * `now` 用来筛掉已过期的：把它们读进内存只是让内存立刻再删一遍。
   * 这里用 `expires_at <= now` 而不是重算 TTL —— TTL 可能在两次启动之间被
   * 改小，那种情况下多留一会儿由内存侧的 `fresh()` 收口（它按当前 TTL 判）。
   */
  loadSessions(now: number): StoredBinding[] {
    /*
     * `LIMIT` 从内存侧的 cap 推导。
     *
     * `restore()` 不调 `evict`，所以装载量若超过 cap，内存会在**下一次
     * `bindSession` 之前**一直超容 —— 而那一次 `evict` 会一口气 FIFO 淘汰掉
     * (size - cap) 个**活跃**绑定，正是「先清过期」那条承重规则要防的事，
     * 只是触发路径从「攻击者灌表」换成了「重启」。
     *
     * 取**最新的** cap 条（`DESC LIMIT` 后反转）而不是最老的：超容时该留下
     * 最可能还活跃的那些。反转是为了让返回顺序仍是升序 —— `Map` 的迭代顺序
     * 就是 FIFO 淘汰顺序，见类注释。
     */
    const rows = (
      this.#db
        .prepare(
          `SELECT session_hash, worker_id, bound_at FROM session_affinity
           WHERE expires_at > ? ORDER BY bound_at DESC LIMIT ?`,
        )
        .all(now, SESSION_CAP) as Array<Record<string, unknown>>
    ).reverse();
    return rows.map((r) => ({
      hash: r["session_hash"] as string,
      workerId: r["worker_id"] as string,
      at: r["bound_at"] as number,
    }));
  }

  loadBlobs(now: number): StoredBinding[] {
    // 同 `loadSessions`：取最新的 cap 条，再反转回升序。
    const rows = (
      this.#db
        .prepare(
          `SELECT blob_hash, worker_id, learned_at FROM blob_affinity
           WHERE expires_at > ? ORDER BY learned_at DESC LIMIT ?`,
        )
        .all(now, BLOB_CAP) as Array<Record<string, unknown>>
    ).reverse();
    return rows.map((r) => ({
      hash: r["blob_hash"] as string,
      workerId: r["worker_id"] as string,
      at: r["learned_at"] as number,
    }));
  }

  /** 清掉已过期的行。启动时跑一次即可 —— 这张表的增长受内存侧容量上限约束。 */
  pruneExpired(now: number): number {
    let removed = 0;
    this.#safe("pruneExpired", () => {
      const a = this.#db.prepare("DELETE FROM session_affinity WHERE expires_at <= ?").run(now);
      const b = this.#db.prepare("DELETE FROM blob_affinity WHERE expires_at <= ?").run(now);
      removed = Number(a.changes) + Number(b.changes);
    });
    return removed;
  }
}
