import type { DatabaseSync, StatementSync } from "node:sqlite";
import { BATCH_STATES, INITIAL, type BatchProgress, type BatchState } from "../../shared/batchProbe.ts";

/**
 * 批量探测进度的持久化。
 *
 * ## 为什么进度必须归服务端所有
 *
 * 需求要求「刷新页面能接着看，不依赖前端内存」。理由不只是便利:探测**已经在跑**
 * （它在切 Clash selector、在发真实网络请求），而前端内存里的进度只是它的一个
 * 倒影。把真相放在前端意味着刷新之后**真相就没了** —— 而那批探测还在跑，
 * 用户此时看到「空闲」并再点一次开始，就会有两批并发互相换掉对方的出口节点。
 *
 * 所以状态机的**当前状态**在库里，前端只是渲染它。
 *
 * ## 只保留一条记录
 *
 * 同一时刻只允许一批探测（见 reducer 的 `start` 分支）。表做成 `id` 主键是为了
 * 将来可能的历史记录，但现在固定用 `SINGLETON` —— 并发控制因此变成
 * 一个 `UPDATE ... WHERE state = ?`，由 SQLite 保证原子。
 */

/** 唯一一行的主键。见类注释:同一时刻只允许一批。 */
const JOB_ID = "SINGLETON";

export class BatchProbeStore {
  #writeFailures = 0;
  #lastWriteError: string | null = null;
  /**
   * 读失败后停用持久化。读不出的库(页损坏、列类型被改)再写也多半失败,
   * 而写成功会用一份全新进度盖掉可能还能手工救回的旧行。
   */
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

  /**
   * 写失败计数。与两个 store 同一条规则:吞掉异常但**可观测**。
   *
   * 长任务的进度写失败**不该让探测停下** —— 探测本身是有价值的工作，
   * 而进度只是它的显示。但吞掉不等于可以不知道:进度卡住不动而探测在跑，
   * 看起来就像「卡死了」。
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

  /** 落盘当前进度。 */
  save(progress: BatchProgress, now: number, startedAt?: number): void {
    if (this.#disabled) return;
    this.#safe("saveBatchProgress", () => {
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

  /**
   * 读回进度。没有记录时返回 `INITIAL`（而不是 null）——
   * 「从未跑过」与「空闲」对前端是同一件事，多一个 null 分支只会让调用点更长。
   */
  load(): { progress: BatchProgress; startedAt: number | null } {
    /*
     * 读失败与写失败同一处置:计数、可诊断、不抛。启动路径(`recoverInterrupted`、
     * `BatchProbeRunner` 构造)都调它,抛出会让一个坏掉的进度表拖垮整个网关。
     */
    let row: Record<string, unknown> | undefined;
    let readOk = false;
    this.#safe("loadBatchProgress", () => {
      row = this.#read.get(JOB_ID) as Record<string, unknown> | undefined;
      readOk = true;
    });
    if (!readOk) {
      this.#disabled = true;
      return { progress: INITIAL, startedAt: null };
    }
    if (row === undefined) return { progress: INITIAL, startedAt: null };

    /*
     * `state` 过一遍字母表。
     *
     * 库里那列有 CHECK 约束，所以理论上不会是别的值 —— 但「理论上」不够:
     * 一个被手工编辑过的库（或将来某个新增状态的更高档位程序写下的值）
     * 会让前端拿到一个它不认识的状态，而那时 UI 的 switch 会静默走到默认分支。
     * 认不出就当 `idle`,并**不**声称这是正常的。
     */
    const raw = String(row["state"]);
    const state: BatchState = (BATCH_STATES as readonly string[]).includes(raw)
      ? (raw as BatchState)
      : "idle";

    let addedWorkerIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row["added_worker_ids"] ?? "[]"));
      if (Array.isArray(parsed)) addedWorkerIds = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 坏 JSON 当空数组 —— 那只是「跳转查看新建 Worker」这个便利功能失效。
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
   * 进程启动时把**遗留的进行中状态**收尾。
   *
   * 崩溃或 `kill -9` 会让库里留下 `running` —— 而那批探测**已经不在跑了**
   * （它活在上一个进程里）。不收尾的话前端会永远显示「探测中…」，
   * 按钮永远禁用，而唯一的出路是手工改库。
   *
   * 标成 `done` 且带一个 `failureKind`,让「它是被打断的」可见 ——
   * 静默标成 idle 会让用户以为那批探测正常完成了。
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
