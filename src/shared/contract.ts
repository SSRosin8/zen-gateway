import { z } from "zod";

/**
 * server ⇄ admin ⇄ CLI 的唯一契约。
 *
 * Phase 0 只放最小集合以打通类型链路；配置与存储的完整 schema 在 Phase 1。
 * 规则：三端都从这里导入推导类型，任何一端改字段，另两端 typecheck 失败。
 */

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * Worker 池的健康态。
 *
 * `empty` 必须是独立的一态，不能折进 `healthy`：全新安装时 Worker 数为 0,
 * 朴素写法 `ready === total` 得到 `0 === 0` 为真，于是首启第一眼就显示
 * 「全部健康」，而实际什么都没配。
 */
export const PoolHealthSchema = z.enum(["empty", "healthy", "degraded"]);
export type PoolHealth = z.infer<typeof PoolHealthSchema>;

export function poolHealth(counts: { ready: number; total: number }): PoolHealth {
  if (counts.total === 0) return "empty";
  return counts.ready === counts.total ? "healthy" : "degraded";
}
