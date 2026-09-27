import type { Context } from "hono";
import { ProbeReportSchema, ProbeRequestSchema } from "../../../shared/contract.ts";
import { DIRECT_EGRESS_ID } from "../../../shared/schema.ts";
import { applyProbeResults } from "../../../core/proxy/egress.ts";
import { usedProxyIds } from "../../../core/routing/workerPool.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import type { AdminDeps } from "../admin.ts";
import { adminError, readJsonBody } from "./common.ts";

/**
 * 探测在用的出口并把实测 IP 写回配置：隔离报告按 `config.proxies[].egressIp` 分组，
 * 只探测不写回则隔离永远无法成立。探测走服务自己的 `EgressService`（不变量 #7 的延伸）。
 *
 * 请求体可带 `proxyIds` 只探指定出口（前端逐个探测以显示进度，出口页单行探测）；
 * 未知 id 整体 404，不探一半。省略时探全部在用出口。
 */
export async function probeUsedEgress(c: Context, deps: AdminDeps): Promise<Response> {
  const body = await readJsonBody(c, ProbeRequestSchema);
  if (!body.ok) return body.response;
  if (deps.egress === undefined) {
    return adminError(c, "internal_error", "出口服务不可用");
  }

  const config = deps.configOf();
  let proxyIds: Array<string | null>;
  if (body.data.proxyIds !== undefined) {
    const known = new Set(config.proxies.map((p) => p.id));
    const unknown = body.data.proxyIds.filter((id) => id !== DIRECT_EGRESS_ID && !known.has(id));
    if (unknown.length > 0) {
      return adminError(c, "not_found", `没有这些代理:${unknown.slice(0, 5).join("、")}`);
    }
    proxyIds = [...new Set(body.data.proxyIds)].map((id) => (id === DIRECT_EGRESS_ID ? null : id));
  } else {
    proxyIds = usedProxyIds(config);
    if (proxyIds.length === 0) {
      return adminError(c, "invalid_config", "没有可用的 Worker,无从探测出口");
    }
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

/**
 * 与批量探测互斥地运行一次探测：两者都会切 Clash selector，交错时探到的 IP 不属于被测节点。
 */
export async function probeExclusive(c: Context, deps: AdminDeps): Promise<Response> {
  if (deps.batch === undefined) return await probeUsedEgress(c, deps);
  const outcome = await deps.batch.runExclusive(() => probeUsedEgress(c, deps));
  if (outcome === null) {
    return adminError(c, "conflict", "批量探测或另一次出口探测正在进行,请等它结束后再试");
  }
  return outcome.value;
}
