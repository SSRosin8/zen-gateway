import type { Context } from "hono";
import { ProbeReportSchema } from "../../../shared/contract.ts";
import { applyProbeResults } from "../../../core/proxy/egress.ts";
import { usedProxyIds } from "../../../core/routing/workerPool.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import type { AdminDeps } from "../admin.ts";
import { adminError } from "./common.ts";

/**
 * 探测在用的出口并把实测 IP 写回配置：隔离报告按 `config.proxies[].egressIp` 分组，
 * 只探测不写回则隔离永远无法成立。探测走服务自己的 `EgressService`（不变量 #7 的延伸）。
 * `POST /api/probe` 与深度诊断共用。
 */
export async function probeUsedEgress(c: Context, deps: AdminDeps): Promise<Response> {
  if (deps.egress === undefined) {
    return adminError(c, "internal_error", "出口服务不可用");
  }

  const config = deps.configOf();
  const proxyIds = usedProxyIds(config);
  if (proxyIds.length === 0) {
    return adminError(c, "invalid_config", "没有可用的 Worker,无从探测出口");
  }

  let results;
  try {
    results = await deps.egress.probeAll(config, proxyIds);
  } catch (err) {
    deps.log?.(`出口探测失败: ${safeErrorMessage(err)}`);
    return adminError(c, "internal_error", `探测失败:${safeErrorMessage(err)}`);
  }

  /*
   * 合并前必须重读配置：探测耗时数秒，用开始前的快照写回会覆盖用户期间的改动。
   * 订阅刷新与 `batchRunner.#persist` 同样防了这个，三处须一致（纪律 #4）。
   * 失败不清空已有 IP；`applyProbeResults` 同时处理直连（`__direct__` → `gateway.directEgressIp`）。
   */
  const byProxy = new Map(results.map((r) => [r.proxyId, r.outcome] as const));
  const fresh = deps.configOf();
  const merged = applyProbeResults(fresh, byProxy);
  const changed = merged.changed;

  if (changed) {
    try {
      await deps.applyConfig(merged.config, fresh);
    } catch (err) {
      deps.log?.(`探测结果写入失败: ${safeErrorMessage(err)}`);
      return adminError(c, "write_failed", `探测成功但写入失败:${safeErrorMessage(err)}`);
    }
  }

  // 返回每个出口的结果（含失败原因）；过 schema 防将来新增字段被无意带出。
  return c.json(
    ProbeReportSchema.parse({
      ok: true,
      changed,
      results: results.map((r) => ({
        proxyId: r.proxyId,
        ...(r.outcome.ok
          ? { ok: true as const, egressIp: r.outcome.egressIp, latencyMs: r.outcome.latencyMs, via: r.outcome.via }
          : { ok: false as const, failureKind: r.outcome.failureKind, reason: r.outcome.reason }),
      })),
    }),
  );
}
