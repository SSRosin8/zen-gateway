import { readFileSync } from "node:fs";
import { configPath } from "./paths.ts";

/**
 * 端口解析的唯一真相（纪律 #4），供 `server/index.ts`、`scripts/service.mjs`、
 * `vite.config.ts` 共用，否则各处会探测或转发到不同端口。
 *
 * 优先级：`ZG_PORT` > `config.json` 的 `gateway.port` > 9876。
 * `ZG_PORT` 让测试能与 `ZG_DATA_DIR` 一起隔离端口。
 */

export const DEFAULT_PORT = 9876;

/** ZG_PORT 非法时抛出，由调用方决定怎么退出。 */
export class PortResolveError extends Error {
  override readonly name = "PortResolveError";
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 解析该用哪个端口。`root` 只在测试里传，与 `configPath` 约定一致。
 * 非法 `ZG_PORT` 抛错而不静默回落。
 */
export function resolvePort(root?: string): number {
  const fromEnv = process.env["ZG_PORT"];
  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = Number(fromEnv);
    if (!validPort(parsed)) {
      throw new PortResolveError(`ZG_PORT 不是合法端口:${fromEnv}`);
    }
    return parsed;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(configPath(root), "utf8"));
    const port = (raw as { gateway?: { port?: unknown } } | null)?.gateway?.port;
    if (validPort(port)) return port;
  } catch {
    // 配置不存在或不可解析时用默认端口；真正的原因由加载配置时报告。
  }

  return DEFAULT_PORT;
}
