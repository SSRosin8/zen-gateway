import type { DatabaseSync, StatementSync } from "node:sqlite";
import { WriteFailures } from "./writeFailures.ts";
import { BATCH_STATES, INITIAL, type BatchProgress, type BatchState } from "../../shared/batchProbe.ts";

/**
 * 批量探测进度的持久化。进度归服务端所有：刷新页面后前端若看到「空闲」再点开始，
 * 会与仍在跑的那批并发互换出口节点。
 */

/** 唯一一行的主键：同一时刻只允许一批（见 reducer 的 `start` 分支）。 */
const JOB_ID = "SINGLETON";

export class BatchProbeStore {
  #writes = new WriteFailures();
  /** 读失败后停用持久化，避免用全新进度盖掉可能还能手工救回的旧行。 */
  #disabled = false;

  #upsert: StatementSync;
  #read: StatementSync;

  constructor(db: DatabaseSync) {

    this.#upsert = db.prepare(`
      INSERT INTO batch_probe_jobs (
        id, state, screen_total, screen_done, main_total, main_done,
        cancel_requested, added_worker_ids, failure_kind, started_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        state            = excluded.state,
        screen_total     = excluded.screen_total,
        screen_done      = excluded.screen_done,
        main_total       = excluded.main_total,
        main_done        = excluded.main_done,
        cancel_requested = excluded.cancel_requested,
        added_worker_ids = excluded.added_worker_ids,
        failure_kind     = excluded.failure_kind,
        -- started_at 也要更新：不在这个列清单里的话，第一次批测写下的值会
        -- 存一辈子，「已跑多久」就会得到一个荒谬的数字。
        -- BatchProgress.elapsedMs 读它，所以这一行是承重的。
        started_at       = excluded.started_at,
        updated_at       = excluded.updated_at
    `);

    this.#read = db.prepare(`
      SELECT state, screen_total, screen_done, main_total, main_done,
             cancel_requested, added_worker_ids, failure_kind, started_at, updated_at
      FROM batch_probe_jobs WHERE id = ?
    `);
  }

  /** 写失败计数：进度写失败不让探测停下，但要可观测。 */
  writeFailures(): { count: number; lastError: string | null } {
    return this.#writes.snapshot();
  }

  /** 落盘当前进度。 */
  save(progress: BatchProgress, now: number, startedAt?: number): void {
    if (this.#disabled) return;
    this.#writes.guard("saveBatchProgress", () => {
      this.#upsert.run(
        JOB_ID,
        progress.state,
        progress.screenTotal,
        progress.screenDone,
        progress.mainTotal,
        progress.mainDone,
        progress.cancelRequested ? 1 : 0,
        JSON.stringify(progress.addedWorkerIds),
        progress.failureKind,
        startedAt ?? now,
        now,
      );
    });
  }

  /** 读回进度。没有记录时返回 `INITIAL`：「从未跑过」与「空闲」对前端相同。 */
  load(): { progress: BatchProgress; startedAt: number | null } {
    // 读失败也只计数不抛：启动路径调用它，坏掉的进度表不该拖垮网关。
    let row: Record<string, unknown> | undefined;
    let readOk = false;
    this.#writes.guard("loadBatchProgress", () => {
      row = this.#read.get(JOB_ID) as Record<string, unknown> | undefined;
      readOk = true;
    });
    if (!readOk) {
      this.#disabled = true;
      return { progress: INITIAL, startedAt: null };
    }
    if (row === undefined) return { progress: INITIAL, startedAt: null };

    // `state` 过一遍字母表：手工编辑或更高档位写下的未知状态当 `idle`。
    const raw = String(row["state"]);
    const state: BatchState = (BATCH_STATES as readonly string[]).includes(raw)
      ? (raw as BatchState)
      : "idle";

    let addedWorkerIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row["added_worker_ids"] ?? "[]"));
      if (Array.isArray(parsed)) addedWorkerIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 坏 JSON 当空数组，只影响「跳转查看新建 Worker」。
    }

    return {
      progress: {
        state,
        screenTotal: Number(row["screen_total"] ?? 0),
        screenDone: Number(row["screen_done"] ?? 0),
        mainTotal: Number(row["main_total"] ?? 0),
        mainDone: Number(row["main_done"] ?? 0),
        cancelRequested: Number(row["cancel_requested"] ?? 0) === 1,
        addedWorkerIds,
        failureKind: (row["failure_kind"] as string | null) ?? null,
      },
      startedAt: Number(row["started_at"] ?? 0) || null,
    };
  }

  /**
   * 进程启动时把上个进程遗留的进行中状态收尾，否则前端永远显示「探测中」。
   * 标成 `done` 并带 `failureKind: "interrupted"`，让中断可见。
   */
  recoverInterrupted(now: number): boolean {
    const { progress, startedAt } = this.load();
    if (progress.state === "idle" || progress.state === "done") return false;

    this.save(
      { ...progress, state: "done", failureKind: "interrupted" },
      now,
      startedAt ?? now,
    );
    return true;
  }
}
