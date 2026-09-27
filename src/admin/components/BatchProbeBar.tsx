import { useState } from "react";
import type { BatchProgressView } from "../../shared/contract.ts";
import { isActive, percentages } from "../../shared/batchProbe.ts";
import { StatusIndicator, type StatusTone } from "./StatusIndicator.tsx";
import { SecondaryButton, Strong } from "./Panel.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import type { useBatchProbe } from "../lib/api.ts";
import { humanMs } from "../lib/format.ts";

/**
 * 出口页的批量探测：工具栏里一个按钮 + 一行进度。逐个节点的状态不在这里，
 * 而是显示在节点表对应的行上（`BatchProgressView.nodes`）——测到哪一个就在哪一行看到。
 *
 * ## 两段进度分开，不合成百分比
 *
 * 筛选（本地判断）比主探测（真发请求 + 切 selector）快得多，合成的百分比会先飞到 40% 再慢爬。
 *
 * ## `cancelling` 是独立态
 *
 * 取消是「请求已发出、等服务端确认」：后台那一批还在切 selector，此时放开「开始」会并发第二批。
 */
export function BatchProbeBar({ control }: { control: ReturnType<typeof useBatchProbe> }) {
  const { progress } = control;
  const running = isActive(progress);
  const [confirming, setConfirming] = useState(false);
  const [createWorkers, setCreateWorkers] = useState(false);
  const pct = percentages(progress);

  const stateLabel: Record<BatchProgressView["state"], string> = {
    idle: "未开始",
    screening: `筛选中 ${progress.screenDone}/${progress.screenTotal}`,
    running: `探测中 ${progress.mainDone}/${progress.mainTotal}`,
    paused: `已暂停 ${progress.mainDone}/${progress.mainTotal}`,
    cancelling: "正在取消…",
    done: progress.failureKind === null ? `已完成 ${progress.mainDone}/${progress.mainTotal}` : `已结束（${progress.failureKind}）`,
  };
  const tone: StatusTone =
    progress.state === "done" ? (progress.failureKind === null ? "success" : "warn") : running ? "info" : "neutral";
  const failed = progress.nodes.filter((n) => n.state === "failed").length;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-batch-probe="">
      <span className="flex flex-wrap gap-2">
        {progress.state === "running" && <SecondaryButton onClick={() => void control.send("pause")}>暂停</SecondaryButton>}
        {progress.state === "paused" && <SecondaryButton onClick={() => void control.send("resume")}>继续</SecondaryButton>}
        {running && (
          <SecondaryButton onClick={() => void control.send("cancel")} disabled={progress.state === "cancelling"}>
            取消
          </SecondaryButton>
        )}
        {!running && progress.state !== "paused" && (
          <SecondaryButton onClick={() => setConfirming(true)}>批量探测全部节点</SecondaryButton>
        )}
      </span>
      {progress.state !== "idle" && (
        <>
          <StatusIndicator
            tone={tone}
            icon={progress.state === "done" && progress.failureKind === null ? "✓" : running ? "◴" : "○"}
            label={progress.elapsedMs === null ? stateLabel[progress.state] : `${stateLabel[progress.state]} · ${humanMs(progress.elapsedMs)}`}
          />
          {(running || progress.state === "paused") && (
            <span
              className="h-2 w-40 overflow-hidden rounded-xs bg-surface-active"
              role="progressbar"
              aria-label="批量探测进度"
              aria-valuenow={(progress.state === "screening" ? pct.screen : pct.main) ?? 0}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              {/* accent-fill 只做填充，上面不压文字。 */}
              <span
                className="block h-full bg-accent-fill"
                style={{ width: `${(progress.state === "screening" ? pct.screen : pct.main) ?? 0}%` }}
              />
            </span>
          )}
          {failed > 0 && <span className="text-text-muted">{failed} 个失败，原因见对应行</span>}
          {progress.addedWorkerIds.length > 0 && (
            <span className="text-text-muted">本批新建 Worker：{progress.addedWorkerIds.join("、")}</span>
          )}
        </>
      )}
      <div aria-live="polite">
        {control.error !== null && (
          <p role="alert">
            <StatusIndicator tone="error" icon="✕" label={control.error} />
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title="开始批量探测"
        confirmLabel="开始探测"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void control.send("start", { createWorkers });
        }}
      >
        <p>逐个探测出口池里全部已启用的节点，测到的公网 IP 写回配置，每个节点的结果显示在它那一行。</p>
        <p>
          经 Clash 桥接的节点会逐个<Strong>切换 Clash 分组的选中节点</Strong>。那是 Clash 的全局状态：
          探测期间本机其他走这个分组的流量也会跟着换出口，结束后不会自动切回。
        </p>
        <label className="flex min-h-[44px] items-center gap-2 text-text">
          <input type="checkbox" checked={createWorkers} onChange={(e) => setCreateWorkers(e.target.checked)} />
          为探测成功、未被使用且出口不重复的节点各新建一个匿名 Worker
        </label>
        <p>同一时刻只允许一批；探测期间可以暂停或取消，进度由服务端保存。</p>
      </ConfirmDialog>
    </div>
  );
}
