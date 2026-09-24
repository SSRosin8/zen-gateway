import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
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

describe("库文件权限", () => {
  /*
   * 本项目对 `data/` 下的东西一律 0600（config.json、日志、state 都是），
   * 而 SQLite 按 umask 建文件 —— 实测是 **0644**。库里有会话摘要、
   * Worker id 与用量明细：不是凭证，但足以还原「谁在什么时候用哪个账号
   * 跑了多少 token」，而且这张库会进备份与诊断导出。
   *
   * `data/` 是 0700 所以同机其他用户实际进不来 —— 但依赖目录权限是**单点
   * 防护**，任何一次目录权限被改宽都会让文件权限直接暴露。
   */
  it("openRuntimeDb 把库与 WAL/SHM 都收到 0600", async () => {
    const { openRuntimeDb, dbPath } = await import("../../src/store/db/open.ts");
    const db = await openRuntimeDb(root);
    try {
      // 写一笔，确保 WAL/SHM 真的被创建出来（空库可能还没有）。
      db.exec("INSERT INTO worker_stats (worker_id) VALUES ('w1')");

      const target = dbPath(root);
      for (const path of [target, `${target}-wal`, `${target}-shm`]) {
        const st = await stat(path);
        expect(st.mode & 0o777, `${path} 应当是 0600`).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });
});

describe("档位 2：摘要列的字节长度约束", () => {
  /*
   * 第七轮审核实测出的绕过：SQLite 的 `length()` 与 `GLOB` 对 TEXT 都在
   * 首个 NUL 字节处停止，所以档位 1 的 `length(hash) = 64` 可以被
   * 「64 个 hex + 一个 NUL + 任意明文」通过 —— 明文完整落盘，而所有读路径
   * 都在 NUL 处截断看不见它。档位 2 补 `length(CAST(... AS BLOB)) = 64`。
   *
   * 这些断言直接打在 SQL 层（不经 AffinityStore），因为要验的是**结构约束**
   * 本身 —— 经过 store 的话 `#safe()` 会把失败吞掉，测出来的是"没抛"而不是
   * "被拦下"。
   */
  const hex64 = "a".repeat(64);

  it("NUL 载荷被拦下 —— 档位 1 的绕过已关闭", () => {
    const db = openDb(file);
    try {
      const ins = db.prepare("INSERT INTO session_affinity VALUES (?, ?, ?, ?)");
      expect(() => ins.run(`${hex64}\0PATIENT RECORD`, "w1", 1, 2)).toThrow(/CHECK/);
      expect(() => ins.run(`${"b".repeat(63)}\0`, "w1", 1, 2)).toThrow(/CHECK/);

      const insBlob = db.prepare("INSERT INTO blob_affinity VALUES (?, ?, ?, ?)");
      expect(() => insBlob.run(`${hex64}\0RAW REASONING`, "w1", 1, 2)).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("合法的 64 位小写十六进制仍然能写 —— 约束没有收得过紧", () => {
    const db = openDb(file);
    try {
      db.prepare("INSERT INTO session_affinity VALUES (?, ?, ?, ?)").run(hex64, "w1", 1, 2);
      db.prepare("INSERT INTO blob_affinity VALUES (?, ?, ?, ?)").run(hex64, "w1", 1, 2);
      expect(db.prepare("SELECT COUNT(*) AS c FROM session_affinity").get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });

  it("多字节字符仍被拦下 —— 两个长度条件各司其职", () => {
    const db = openDb(file);
    try {
      const ins = db.prepare("INSERT INTO session_affinity VALUES (?, ?, ?, ?)");
      // 64 字符 / 192 字节：字符长度过关而字节长度不过。
      expect(() => ins.run("一".repeat(64), "w1", 1, 2)).toThrow(/CHECK/);
      // 64 字节 / 64 字符但非 hex。
      expect(() => ins.run("Z".repeat(64), "w1", 1, 2)).toThrow(/CHECK/);
      // 大写 hex 也不行（`digestOf` 输出小写）。
      expect(() => ins.run("A".repeat(64), "w1", 1, 2)).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("从档位 1 升级到 2 不丢数据 —— 重建表要搬行", () => {
    /*
     * 这条同时是**多档位迁移路径的首次真跑**：在 Phase 7 之前
     * `MIGRATIONS` 只有一档，`migrate()` 的循环从未在"跨一档以上"的
     * 情况下执行过。
     */
    const db = openDb(file);
    try {
      // 先降档并塞回档位 1 的形状，模拟一个真实的旧库。
      db.exec("DROP TABLE session_affinity");
      db.exec(`CREATE TABLE session_affinity (
        session_hash TEXT PRIMARY KEY CHECK (
          length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*'),
        worker_id TEXT NOT NULL, bound_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT`);
      db.prepare("INSERT INTO session_affinity VALUES (?, ?, ?, ?)").run(hex64, "w-old", 111, 222);

      /*
       * 降档要**把后续档位建的东西也撤掉**，否则重开时档位 3 会撞上
       * 「table already exists」—— 那不是迁移的缺陷，是这个测试没把库
       * 退回到一个真实的档位 1 状态（我第一版就漏了这步）。
       */
      db.exec("DROP TABLE IF EXISTS gateway_rejections");
      db.exec(`CREATE TABLE model_usage_v1 AS
        SELECT model, worker_id, day, input_tokens, output_tokens,
               cache_read_tokens, cache_write_tokens,
               requests_with_usage, requests_without_usage FROM model_usage`);
      db.exec("DROP TABLE model_usage");
      db.exec("ALTER TABLE model_usage_v1 RENAME TO model_usage");
      db.exec("PRAGMA user_version = 1");
    } finally {
      db.close();
    }

    const again = openDb(file);
    try {
      expect(currentVersion(again)).toBe(TARGET_VERSION);
      // 旧行必须还在，且字段值原样。
      expect(
        again.prepare("SELECT session_hash, worker_id, bound_at FROM session_affinity").all(),
      ).toEqual([{ session_hash: hex64, worker_id: "w-old", bound_at: 111 }]);
      // 索引要被重建 —— 重建表会连带丢掉它。
      const idx = again
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_expires'")
        .all();
      expect(idx).toHaveLength(1);
      // 新约束在升级后的表上生效。
      expect(() =>
        again.prepare("INSERT INTO session_affinity VALUES (?, ?, ?, ?)").run(`${hex64}\0x`, "w", 1, 2),
      ).toThrow(/CHECK/);
    } finally {
      again.close();
    }
  });
});
