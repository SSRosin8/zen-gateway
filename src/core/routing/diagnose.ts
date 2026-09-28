import type { Worker } from "../../shared/schema.ts";
import { humanMs } from "../../shared/duration.ts";
import { isUsable } from "./workerPool.ts";
import type { LayerResult } from "../proxy/clash/diagnose.ts";

/**
 * Worker 层诊断，`npm run doctor` 第 4 层与 `GET /api/diagnostics` 共用（纪律 #4）。
 * 可用性判定复用调度器的 `isUsable()`；就绪态必须来自调度器本身，拿不到时只报配置形态，
 * 不在这里另算一遍冷却。
 */

export type WorkerRuntimeView = {
  id: string;
  inPool: boolean;
  ready: boolean;
  cooldownRemainingMs: number;
  consecutiveFails: number;
  lastFailure: string | null;
};

export function diagnoseWorkers(
  workers: readonly Worker[],
  runtime: readonly WorkerRuntimeView[] | null,
  where: string,
): LayerResult {
  const usable = workers.filter(isUsable);

  if (workers.length === 0) {
    return {
      status: "fail",
      text: "没有配置任何 Worker",
      nextStep: `${where}:\n  { "id": "w1", "kind": "authenticated", "apiKey": "<你的 Zen key>", "proxyId": null }\n或显式添加免 key 的匿名 Worker。`,
    };
  }

  if (usable.length === 0) {
    return {
      status: "fail",
      text: `${workers.length} 个 Worker 全部不可用（已停用或认证 Worker 缺 apiKey）`,
      detail: workers
        .map((w) => `${w.id}: ${!w.enabled ? "已停用" : w.kind === "authenticated" && w.apiKey.trim() === "" ? "认证 Worker 的 apiKey 为空" : "不可用"}`)
        .join("\n"),
      nextStep: "把 enabled 改为 true；认证 Worker 还要确认 apiKey 非空。",
    };
  }

  const bound = usable.filter((w) => w.proxyId !== null).length;
  const shape = `其中 ${bound} 个绑定了出口代理，${usable.length - bound} 个走本机直连。`;

  if (runtime === null) {
    return {
      status: usable.length < workers.length ? "warn" : "pass",
      text: `${usable.length}/${workers.length} 个 Worker 可用（仅配置形态）`,
      detail:
        `${shape}\n` +
        `⚠️ 没能从 /api/overview 拿到运行期状态，所以「是否就绪（不在冷却中）」这一项未检查。\n` +
        `   doctor 刻意不自己算一遍冷却：那会是第二份并行真相，且必然与调度器分叉。`,
    };
  }

  const ready = runtime.filter((w) => w.ready);
  const cooling = runtime.filter((w) => w.inPool && !w.ready);
  const coolingLines = cooling.map(
    (w) =>
      `   ${w.id}: 冷却中 ${humanMs(w.cooldownRemainingMs)}` +
      `${w.lastFailure === null ? "" : `(${w.lastFailure})`}` +
      `${w.consecutiveFails > 0 ? ` · 连续失败 ${w.consecutiveFails} 次` : ""}`,
  );

  // 全员冷却时转发此刻不可用（all_cooling 只会打到最早恢复者），所以是 fail；部分冷却是 warn。
  const allCooling = ready.length === 0 && runtime.some((w) => w.inPool);
  const status = allCooling ? "fail" : cooling.length > 0 || usable.length < workers.length ? "warn" : "pass";

  return {
    status,
    text: `${ready.length}/${usable.length} 个 Worker 就绪（共配置 ${workers.length} 个）`,
    detail: [shape, ...coolingLines].join("\n"),
    ...(allCooling
      ? {
          nextStep:
            "全部 Worker 都在冷却 —— 此刻转发会打到最早恢复的那个。\n" +
            "若冷却类别是 auth，那是 key 配错了（固定 60 秒短退避，会反复暴露）；\n" +
            "若是 rate_limit，那是上游限流，等它过去。",
        }
      : {}),
  };
}
