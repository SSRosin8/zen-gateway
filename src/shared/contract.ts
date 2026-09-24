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
  /**
   * 应答进程的 pid。
   *
   * 供 service.mjs 验明进程身份:光凭状态文件里的数字不能证明那个进程
   * 是我们的服务(PID 会被系统复用),而能应答这个端口的进程就是占着
   * 这个端口的进程 —— 这是「该不该给它发 SIGTERM」的强证明。
   * 管理面仅 loopback,pid 对同一用户不构成信息泄露。
   */
  pid: z.number().int().positive(),
  /**
   * 统计与亲和持久化的**累计写失败次数**。
   *
   * 两个 store 都吞掉写异常（诊断设施不该让转发失败），但**吞掉不等于可以
   * 不知道**：一个一直写失败的库会安静地给出全 0 报表，而那看起来像
   * 「没人用」。第七轮审核指出那个计数此前**没有任何生产读者** ——
   * 与 `Scheduler.snapshot()` 同一形态。
   *
   * 放在 `/health` 而不是等 Phase 8 的 `doctor`：`service.mjs` 本来就在轮询
   * 这个端点，而 doctor 也可以读它 —— 一个出口服务两个消费者。
   *
   * 0 是正常值。非 0 说明库有问题（磁盘满／权限／档位），统计数字不可信。
   */
  storeWriteFailures: z.number().int().nonnegative(),
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
