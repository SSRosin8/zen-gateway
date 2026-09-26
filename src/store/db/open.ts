import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { DIR_MODE, FILE_MODE } from "../paths.ts";
import { MIGRATIONS, TARGET_VERSION } from "./migrations.ts";

/** SQLite 连接与迁移执行，使用 Node 内置的 `node:sqlite`。 */

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
 * 打开数据库并迁移到目标档位。每条迁移与 user_version 更新同在一个事务里，
 * 避免表建了一半而档位已前进。
 */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);

  // WAL：管理后台轮询的同时转发链路在写统计。
  db.exec("PRAGMA journal_mode = WAL");
  // NORMAL 在 WAL 下已能保证崩溃一致性，FULL 对高频统计写不值得。
  db.exec("PRAGMA synchronous = NORMAL");
  // 刻意不用外键：worker_id/proxy_id 是对 config.json 的弱引用，删 Worker 不删历史。
  db.exec("PRAGMA busy_timeout = 5000");
  // 删除时擦掉页内容：默认 `DELETE` 只标记空闲页，`pruneExpired` / `pruneDetailsBefore`
  // 删掉的行仍会留在文件里。
  db.exec("PRAGMA secure_delete = ON");

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
      // user_version 不接受参数绑定，只能拼接自有的整数常量。
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

/**
 * 供服务端启动使用：确保目录存在后打开。SQLite 按 umask 建出 0644 文件，
 * 而库里有会话摘要与用量明细；目录与文件各自都要收紧，不依赖单点防护。
 */
export async function openRuntimeDb(root?: string): Promise<DatabaseSync> {
  const file = dbPath(root);
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
  const db = openDb(file);
  await hardenDbFiles(file);
  return db;
}

/**
 * 把库文件及其 WAL/SHM 旁路文件（同样含数据）收到 0600。失败不抛但打日志，
 * 不支持 chmod 的文件系统不该让网关起不来。
 */
async function hardenDbFiles(file: string): Promise<void> {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const st = await stat(path);
      if ((st.mode & 0o777) !== FILE_MODE) await chmod(path, FILE_MODE);
    } catch (err) {
      // WAL/SHM 在某些时刻不存在，不是错误。
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.error(`无法收紧 ${path} 的权限(库仍可用):${(err as Error).message}`);
    }
  }
}
