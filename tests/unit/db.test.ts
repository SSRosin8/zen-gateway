import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MigrationError, currentVersion, migrate, openDb } from "../../src/store/db/open.ts";
import { MIGRATIONS, TARGET_VERSION } from "../../src/store/db/migrations.ts";

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-db-"));
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  file = join(root, "data", "runtime.db");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("迁移", () => {
  it("新库迁移到目标档位", () => {
    const db = openDb(file);
    try {
      expect(currentVersion(db)).toBe(TARGET_VERSION);
    } finally {
      db.close();
    }
  });

  it("建出预期的表", () => {
    const db = openDb(file);
    try {
      const names = tableNames(db);
      for (const expected of [
        "worker_stats",
        "model_usage",
        "upstream_attempts",
        "probe_results",
        "session_affinity",
        "blob_affinity",
        "batch_probe_jobs",
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it("幂等：重复迁移不报错、不改档位", () => {
    const db = openDb(file);
    try {
      const before = currentVersion(db);
      expect(migrate(db)).toBe(before);
      expect(migrate(db)).toBe(before);
      expect(currentVersion(db)).toBe(before);
    } finally {
      db.close();
    }
  });

  it("重新打开已有库不重跑迁移", () => {
    const first = openDb(file);
    first.exec("INSERT INTO worker_stats (worker_id, attempts) VALUES ('w1', 7)");
    first.close();

    const second = openDb(file);
    try {
      // 若迁移重跑，CREATE TABLE 会失败或数据被清掉。
      const row = second.prepare("SELECT attempts FROM worker_stats WHERE worker_id='w1'").get() as
        | { attempts: number }
        | undefined;
      expect(row?.attempts).toBe(7);
    } finally {
      second.close();
    }
  });

  it("档位高于程序支持时报错，而不是硬跑", () => {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${TARGET_VERSION + 5}`);
    db.close();

    const reopened = new DatabaseSync(file);
    try {
      expect(() => migrate(reopened)).toThrow(MigrationError);
    } finally {
      reopened.close();
    }
  });

  it("迁移失败时整条回滚，不留半截 schema", () => {
    const db = new DatabaseSync(file);
    try {
      // 人为构造一条会失败的迁移：先建好同名表，让 CREATE TABLE 撞车。
      db.exec("CREATE TABLE worker_stats (x INTEGER)");
      expect(() => migrate(db)).toThrow(MigrationError);

      // 档位必须还在 0 —— 否则这个库既不能用也不能再迁移。
      expect(currentVersion(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("WAL 已启用", () => {
    const db = openDb(file);
    try {
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("迁移版本号唯一且递增", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});

describe("结构约束", () => {
  it("亲和表只接受小写十六进制的 sha256 摘要", () => {
    const db = openDb(file);
    try {
      /*
       * 「只存摘要」必须是结构约束,不能只是约定。
       *
       * 光查长度是不够的:实测 64 个字符的原始推理文本、64 个 CJK 字符
       * (192 字节)都能照常写进来 —— 于是「不可能有人存进原始推理内容」
       * 这句话曾经是假的。加上字符集限制后只有小写十六进制能通过,
       * 正好是 Node 的 digest("hex") 输出形态。
       */
      const insert = (table: "blob_affinity" | "session_affinity", value: string) => () =>
        db.exec(`INSERT INTO ${table} VALUES ('${value}', 'w1', 0, 0)`);

      // 正当的摘要。
      expect(insert("blob_affinity", "a".repeat(64))).not.toThrow();
      expect(insert("session_affinity", "0123456789abcdef".repeat(4))).not.toThrow();

      // 长度对但不是摘要 —— 这些先前全部能写进来。
      expect(insert("blob_affinity", "推".repeat(64)), "64 个 CJK 字符").toThrow();
      expect(
        insert("blob_affinity", "the user asked about their config and i reasoned".padEnd(64, "x")),
        "64 字符的自然语言",
      ).toThrow();
      expect(insert("blob_affinity", "A".repeat(64)), "大写十六进制").toThrow();

      // 长度不对。
      expect(insert("blob_affinity", "a".repeat(63))).toThrow();
      expect(insert("blob_affinity", "原始推理内容")).toThrow();
    } finally {
      db.close();
    }
  });

  it("批测任务的 state 只接受状态机里的取值", () => {
    const db = openDb(file);
    try {
      const insert = (state: string) => () =>
        db.exec(
          `INSERT INTO batch_probe_jobs (id, state, started_at, updated_at) VALUES ('${state}', '${state}', 0, 0)`,
        );

      // 规划定义的六态全部合法 —— 包括 idle。
      // 先前漏了 idle,而 Phase 9 的 reducer 测试会把每个状态都落一遍库,
      // 那时才会炸在一个与真正问题无关的地方。
      for (const state of ["idle", "screening", "running", "paused", "cancelling", "done"]) {
        expect(insert(state), state).not.toThrow();
      }

      expect(insert("乱写")).toThrow();
      expect(insert("")).toThrow();
    } finally {
      db.close();
    }
  });

  it("usage 缺失单独计数，不混进有 usage 的请求", () => {
    const db = openDb(file);
    try {
      db.exec(
        "INSERT INTO model_usage (model, worker_id, day, requests_with_usage, requests_without_usage) VALUES ('m-free','w1','2026-09-22',3,2)",
      );
      const row = db
        .prepare("SELECT requests_with_usage a, requests_without_usage b FROM model_usage")
        .get() as { a: number; b: number };
      // 缺失的 usage 必须如实显示为缺失，不估算、不并入。
      expect(row).toEqual({ a: 3, b: 2 });
    } finally {
      db.close();
    }
  });

  it("一条请求的重试链是多行 attempt，共享 request_id", () => {
    const db = openDb(file);
    try {
      db.exec(`
        INSERT INTO upstream_attempts (request_id, attempt_index, worker_id, protocol, at)
        VALUES ('req-1', 0, 'w1', 'chat', 1), ('req-1', 1, 'w2', 'chat', 2)
      `);
      const rows = db
        .prepare("SELECT worker_id FROM upstream_attempts WHERE request_id='req-1' ORDER BY attempt_index")
        .all() as Array<{ worker_id: string }>;
      // 请求数 ≠ 尝试数，但每次尝试都要在对应 Worker 上可见。
      expect(rows.map((r) => r.worker_id)).toEqual(["w1", "w2"]);
    } finally {
      db.close();
    }
  });
});
