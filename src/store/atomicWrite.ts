import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { FILE_MODE } from "./paths.ts";

/**
 * 原子写：同目录临时文件（跨文件系统 rename 非原子）→ fsync（否则崩溃后可能
 * rename 出空文件）→ rename → fsync 目录。临时文件创建即 0600，没有权限窗口。
 * 失败时清理临时文件并原样抛出，由调用方决定错误分类。
 *
 * `exclusive`：目标已存在则以 EEXIST 失败而不覆盖。用 link 而非先查后写：
 * 两步之间文件被别人创建时，rename 会静默覆盖它。
 */
export async function atomicWriteFile(
  file: string,
  body: string,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", FILE_MODE);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.exclusive === true) {
      await link(temp, file);
      await unlink(temp);
    } else {
      await rename(temp, file);
    }
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw err;
  }

  await syncDir(dir);
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 某些文件系统不支持对目录 fsync；不是致命错误。
  }
}
