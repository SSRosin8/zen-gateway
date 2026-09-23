import { join, resolve } from "node:path";

/**
 * 文件位置 —— 与「怎么解析配置」分开的一层。
 *
 * ## 为什么单独一个文件
 *
 * `scripts/service.mjs` 与 `vite.config.ts` 都需要知道端口(从而需要知道
 * config.json 在哪),但它们**不需要解析配置**。若这层知识留在 `config.ts` 里,
 * 引一次就把 `zod` 与整个 schema 拖进来:实测 `import port.ts`(经 config.ts)
 * 要 **57ms**,而 `node scripts/service.mjs status` 全程只有 51ms ——
 * 把一个常用 CLI 的启动时间翻倍,换来的只是一个路径字符串。
 *
 * 而「易用性:方便简单」是这个项目明确的优先项,`npm run status` 属于那一类。
 *
 * 这一层只依赖 `node:path`,没有 IO、没有校验、没有第三方依赖。
 */

/**
 * data/ 的位置。
 *
 * 显式传 `root` 时以它为准(测试用临时目录走这条路)。不传时才看
 * `ZG_DATA_DIR` —— 必须与 `scripts/service.mjs` 认的是同一个环境变量,
 * 否则 service.mjs 在一个目录里管状态文件,而服务端从另一个目录读配置,
 * 凭证与运行时数据被劈成两份。
 */
export function dataDir(root?: string): string {
  if (root !== undefined) return resolve(root, "data");

  const override = process.env["ZG_DATA_DIR"];
  return override !== undefined && override !== ""
    ? resolve(override)
    : resolve(process.cwd(), "data");
}

export function configPath(root?: string): string {
  return join(dataDir(root), "config.json");
}
