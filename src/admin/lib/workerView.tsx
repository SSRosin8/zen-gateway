import type { WorkerView } from "../../shared/contract.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { Mono, Truncate } from "../components/Panel.tsx";
import type { ProbeRun } from "./api.ts";
import { humanMs } from "./format.ts";

/*
 * Worker 的状态判定与出口单元格。Worker 页、概览与详情侧栏共用一份：两份必然分叉，
 * 分叉后同一个 Worker 在两处显示不同状态，用户会以为其中一处是旧数据。
 */

/**
 * 一个 Worker 现在的状态 —— **三个事实合成一句话**。
 *
 * 顺序即优先级，每一层的下一步都不同：
 *   停用 → 去启用它；没 key → 去填 key；冷却中 → 等，或看 lastFailure；就绪 → 无事
 *
 * 这个函数是「为什么没在用我这个账号」那个问题的答案所在，所以它不能
 * 把几种情况合成「不可用」—— 那样用户仍然不知道原因。
 *
 * 返回类型刻意**窄于 `StatusTone`**（不含 `info`）：`RowMark` 的左边框只为
 * 这四档定了颜色，而 Worker 状态里没有「信息」这一档。写宽了会让 tsc 放过
 * 一个 `RowMark` 接不住的值。
 */
export function workerKindLabel(w: Pick<WorkerView, "kind">): string {
  return w.kind === "anonymous" ? "匿名" : "认证";
}

export function workerStatus(w: WorkerView): {
  tone: "success" | "warn" | "error" | "neutral";
  icon: string;
  label: string;
} {
  if (!w.enabled) return { tone: "neutral", icon: "○", label: "已停用" };
  /*
   * 启用了但没 key —— 必须与「已停用」分开。
   *
   * `isUsable()` 对认证 Worker 要求 apiKey 非空，对匿名 Worker 允许免 key。
   * 这里按 kind 判断，避免把合法的匿名 Worker 误报成缺少凭证。
   */
  if (w.kind === "authenticated" && !w.apiKey.present) {
    return { tone: "error", icon: "✕", label: "缺少 API key" };
  }
  if (!w.inPool) return { tone: "error", icon: "✕", label: "不在候选池" };
  if (!w.ready) {
    const why = w.lastFailure === null ? "" : `（${w.lastFailure}）`;
    return {
      tone: "warn",
      icon: "◴",
      label: `冷却中 ${humanMs(w.cooldownRemainingMs)}${why}`,
    };
  }
  return { tone: "success", icon: "✓", label: "就绪" };
}

/** 在用出口的探测 id，与服务端 `usedProxyIds` 同一判据：候选池里的 Worker，直连记 `__direct__`。 */
export function probeTargets(workers: readonly WorkerView[]): string[] {
  return [...new Set(workers.filter((w) => w.inPool).map((w) => w.proxyId ?? DIRECT_EGRESS_ID))];
}

/**
 * 出口一列：已保存的回显 IP + 共用标记；本轮探测进行中时显示这一行的进度或失败原因。
 * 共用以服务端的 `sharedGroups` 为准，前端不自己按 IP 分组。
 */
export function EgressCell({ w, shared, probe }: { w: WorkerView; shared: boolean; probe: ProbeRun }) {
  const id = w.proxyId ?? DIRECT_EGRESS_ID;
  const result = probe.results[id];
  if (probe.current === id) return <StatusIndicator tone="info" icon="◴" label="探测中…" />;
  if (result !== undefined && !result.ok) {
    return (
      <span className="inline-flex items-baseline gap-2">
        <StatusIndicator tone="error" icon="✕" label="探测失败" />
        <Truncate text={result.reason} maxWidth="16rem" className="text-label-13 text-text-muted" />
      </span>
    );
  }
  if (w.egressIp === null) {
    return <span className="text-text-muted">{w.proxyId === null ? "本机直连 · 未探测" : "未探测"}</span>;
  }
  return (
    <span className="inline-flex items-baseline gap-2">
      <Mono>{w.egressIp}</Mono>
      {w.proxyId === null && <span className="text-label-13 text-text-muted">本机直连</span>}
      {shared && <StatusIndicator tone="error" icon="✕" label="共用" />}
      {result?.ok === true && <span className="text-label-13 text-text-muted">{result.latencyMs}ms</span>}
    </span>
  );
}

