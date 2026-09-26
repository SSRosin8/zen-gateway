import type { DatabaseSync, StatementSync } from "node:sqlite";
import { WriteFailures } from "./writeFailures.ts";
// 容量上限从 `affinity.ts` 取，不另写数字（纪律 #4）。
import { BLOB_CAP, SESSION_CAP } from "../../core/routing/affinity.ts";

/**
 * 会话/指纹亲和的持久化。`AffinityMap` 是唯一真相，这里只是镜像：`node:sqlite`
 * 是同步 API，热路径查库会阻塞事件循环。启动时读入内存，写入时镜像，查询不碰 DB。
 *
 * 写失败吞掉但计数（`writeFailures()`），不影响转发。不在这里做容量淘汰：
 * 规则只在 `AffinityMap.evict()`，调用方把删除镜像过来（纪律 #4）。
 */

export type StoredBinding = {
  readonly hash: string;
  readonly workerId: string;
  /** 绑定/学习的时刻。TTL 由内存侧按 `now - at` 判定，这里只存原值。 */
  readonly at: number;
};

export class AffinityStore {
  #db: DatabaseSync;
  #writes = new WriteFailures();

  #putSession: StatementSync;
  #delSession: StatementSync;
  #putBlob: StatementSync;
  #delBlob: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;

    // `expires_at` 是派生列（`at + ttlMs`），只用于启动筛选与索引；TTL 权威判定在内存侧 `fresh()`。
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
    return this.#writes.snapshot();
  }

  putSession(hash: string, workerId: string, at: number, ttlMs: number): void {
    this.#writes.guard("putSession", () => {
      this.#putSession.run(hash, workerId, at, at + ttlMs);
    });
  }

  deleteSession(hash: string): void {
    this.#writes.guard("deleteSession", () => {
      this.#delSession.run(hash);
    });
  }

  /** 批量学习指纹，放在一个事务里避免逐条 fsync。 */
  putBlobs(hashes: readonly string[], workerId: string, at: number, ttlMs: number): void {
    if (hashes.length === 0) return;
    this.#writes.guard("putBlobs", () => {
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
    this.#writes.guard("deleteBlobs", () => {
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
   * 读出用于恢复内存的未过期绑定，按 `bound_at` 升序：`Map` 的插入顺序就是
   * FIFO 淘汰顺序。TTL 若在重启间改小，由内存侧 `fresh()` 按当前 TTL 收口。
   */
  loadSessions(now: number): StoredBinding[] {
    /*
     * `LIMIT` 取内存侧 cap：`restore()` 不调 `evict`，超容会让下一次 `evict`
     * 一口气淘汰活跃绑定。取最新的 cap 条（`DESC LIMIT`）再反转回升序。
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

  /** 清掉已过期的行。启动时跑一次即可，表的增长受内存侧容量上限约束。 */
  pruneExpired(now: number): number {
    let removed = 0;
    this.#writes.guard("pruneExpired", () => {
      const a = this.#db.prepare("DELETE FROM session_affinity WHERE expires_at <= ?").run(now);
      const b = this.#db.prepare("DELETE FROM blob_affinity WHERE expires_at <= ?").run(now);
      removed = Number(a.changes) + Number(b.changes);
    });
    return removed;
  }
}
