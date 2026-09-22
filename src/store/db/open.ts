import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { MIGRATIONS, TARGET_VERSION } from "./migrations.ts";

/**
 * SQLite 连接与迁移执行。
 *
 * 用 Node 24 内置的 `node:sqlite`,零新增依赖。WAL 已实测可用。
 */

export function dbPath(root?: string): string {
  return join(dataDir(root), "runtime.db");
}

/** 见 ConfigError 处的说明：不用构造器参数属性，strip-only 模式不支持。 */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
  readonly atVersion: number;

  constructor(message: string, atVersion: number) {
    super(message);
    this.atVersion = atVersion;
  }
}

/**
 * 打开数据库并迁移到目标档位。
 *
 * 每条迁移连同 user_version 的更新一起放在一个事务里:中途失败时整条回滚,
 * 不会留下「表建了一半而 user_version 已经前进」的状态 —— 那种库既不能用
 * 也不能再迁移,只能删掉重建。
 */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);

  // WAL:读写并发。管理后台轮询进度的同时转发链路在写统计。
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL 在 WAL 下已能保证崩溃一致性,FULL 的每次 fsync 对高频统计写不值得。
  db.exec("PRAGMA synchronous = NORMAL");
  // 外键在本库里刻意不用:worker_id/proxy_id 是对 config.json 的弱引用,
  // 配置里删掉 Worker 不应该连带删掉它的历史统计。
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);
  return db;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: DatabaseSync): number {
  let version = currentVersion(db);

  if (version > TARGET_VERSION) {
    throw new MigrationError(
      `数据库档位 ${version} 高于本程序支持的 ${TARGET_VERSION};请升级 zen-gateway,或删除 data/runtime.db 重建(只丢运行时统计)`,
      version,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.up);
      // user_version 不接受参数绑定,只能拼接 —— 故 version 必须是我们自己的整数常量。
      db.exec(`PRAGMA user_version = ${Number(m.version)}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new MigrationError(
        `迁移 ${m.version}(${m.name})失败:${err instanceof Error ? err.message : "未知错误"}`,
        version,
      );
    }
    version = m.version;
  }

  return version;
}

/** 供服务端启动使用:确保目录存在后打开。 */
export async function openRuntimeDb(root?: string): Promise<DatabaseSync> {
  const file = dbPath(root);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return openDb(file);
}
