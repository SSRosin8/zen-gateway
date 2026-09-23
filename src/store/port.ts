import { readFileSync } from "node:fs";
import { configPath } from "./paths.ts";

/**
 * 端口解析 —— **唯一真相**。
 *
 * ## 为什么这必须只有一份实现
 *
 * 端口先前在三处各自解析:`server/index.ts`(真正监听的)、
 * `scripts/service.mjs`(健康等待要探的)、`vite.config.ts`(dev 代理要转发的)。
 * 前两处在 Phase 3 就因为脱节炸过一次 —— 我把监听端口从 `ZG_PORT` 改成读
 * `config.gateway.port` 却没同步脚本,于是脚本去探一个没人监听的端口,
 * 健康等待超时后报「启动失败」,而服务其实已经起来了。
 *
 * 第三处(vite)在 2026-09-23 的梳理中被发现**仍然是硬编码的 9876**。
 * 症状比前两处更隐蔽:dev server 照常起、页面照常开,只是 `/health` 与 `/api`
 * 被转发到一个**别的进程**。本机恰好有旧项目 opencode-manager 监听 9876,
 * 于是 admin 会拿到那个服务的响应 —— 一个"看起来在工作但数据来自错误后端"
 * 的故障,而它不会报任何错。
 *
 * 这是验证纪律第 4 条(守卫/名单必须从唯一真相推导)的又一例:三份并行手写的
 * 解析逻辑,脱节方向必然是"有一处被漏掉"。
 *
 * ## 优先级
 *
 * `ZG_PORT` > `config.json` 的 `gateway.port` > 9876。
 *
 * `ZG_PORT` 在最前面不是为测试开的后门:它让测试能把端口与 `ZG_DATA_DIR`
 * 一起隔离,而那是「误杀无关进程」「restart 谎报成功」这类缺陷能有常驻回归
 * 测试的前提(见 service.mjs 的说明)。
 */

export const DEFAULT_PORT = 9876;

/** ZG_PORT 非法时抛这个,由调用方决定怎么退出(脚本与服务端的退出方式不同)。 */
export class PortResolveError extends Error {
  override readonly name = "PortResolveError";
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 解析该用哪个端口。
 *
 * `root` 只在测试里传(与 `configPath` 的约定一致);不传时走 `ZG_DATA_DIR`
 * 或 `cwd/data`。
 *
 * 非法 `ZG_PORT` **抛错而不静默回落** —— 回落会让「我明明设了 ZG_PORT」
 * 变成一个查不出的问题。
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
    /*
     * 配置不存在(首启)或不可解析 —— 用默认端口。
     *
     * 刻意不在这里报错:服务端加载配置时会给出真正的原因(含 zod 的字段级
     * 报错),而这里只负责端口。在这里抢先报一个「配置读不到」会把那条
     * 更有用的消息盖掉。
     */
  }

  return DEFAULT_PORT;
}
