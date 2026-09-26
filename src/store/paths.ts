import { join, resolve } from "node:path";

/**
 * 文件位置，与配置解析分开：`scripts/service.mjs` 与 `vite.config.ts` 只需路径，
 * 不应连带加载 zod 与 schema 拖慢 CLI 启动。只依赖 `node:path`。
 */

/**
 * data/ 的位置。显式 `root` 优先（测试用），否则看 `ZG_DATA_DIR`，
 * 必须与 `scripts/service.mjs` 认同一个环境变量。
 */
export function dataDir(root?: string): string {
  if (root !== undefined) return resolve(root, "data");

  const override = process.env["ZG_DATA_DIR"];
  return override !== undefined && override !== ""
    ? resolve(override)
    : resolve(process.cwd(), "data");
}

/** data/ 下文件与目录的权限：配置、库、日志、状态文件都含凭证或会话摘要。 */
export const FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export function configPath(root?: string): string {
  return join(dataDir(root), "config.json");
}
