import type { Config, Worker } from "../../shared/schema.ts";
import type { AttemptTarget } from "../upstream/retry.ts";

/**
 * Worker 选择 —— Phase 3 的**最小**实现。
 *
 * Phase 5 会把这里扩成完整的调度状态机(分级冷却、会话粘滞、
 * 亲和指纹、全员冷却时选最早恢复的)。本阶段只需「按可用顺序排出候选」,
 * 好让转发链路能端到端跑通。
 *
 * 刻意**不**在这里放冷却或粘滞的半成品:一个半实现的粘滞比没有粘滞更糟 ——
 * 它会在部分情况下生效,于是「为什么这次换了 Worker」变成不可推理的问题。
 * 要么完整要么没有,这是 Phase 5 的边界。
 */

/** Worker 是否可用于转发。 */
export function isUsable(worker: Worker): boolean {
  if (!worker.enabled) return false;
  /*
   * 必须有上游 key。
   *
   * schema 里 `kind: "anonymous"` 允许空 apiKey,那是为「免鉴权免费额度」
   * 留的形态 —— 而上游已于 2026-09-16 前后关闭该通道(免 key 请求免费模型
   * 返回 403 FreeTierError)。没有 key 的 Worker 发出去必定失败,
   * 放进候选链只会白占一次尝试并把真实原因(没配 key)埋进重试日志。
   *
   * 这里按「有没有 key」判断而不按 kind:kind 是用户的声明,
   * key 是能不能用的事实,后者才是调度该依据的。
   */
  return worker.apiKey.trim() !== "";
}

/**
 * 排出候选 Worker。
 *
 * Phase 3 的顺序就是配置里的顺序 —— 稳定、可预测、便于用户自己排优先级。
 * `routing.strategy`(anonymous_first 等)在 Phase 5 接入;
 * 现在就读它会得到一个「看起来在生效其实没管住」的分支。
 */
export function selectTargets(config: Config): AttemptTarget[] {
  return config.workers.filter(isUsable).map((w) => ({
    workerId: w.id,
    apiKey: w.apiKey,
    proxyId: w.proxyId,
  }));
}

/** 供诊断:说明为何没有候选。 */
export function describeNoWorker(config: Config): string {
  if (config.workers.length === 0) {
    return "尚未配置任何 Worker";
  }
  const enabled = config.workers.filter((w) => w.enabled);
  if (enabled.length === 0) {
    return "所有 Worker 都已停用";
  }
  return "所有已启用的 Worker 都缺少上游 API key";
}
