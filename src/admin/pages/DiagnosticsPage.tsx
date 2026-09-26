import { useState } from "react";
import { DiagnosticsSchema, type DiagnosticLayer, type Diagnostics } from "../../shared/contract.ts";
import { Mono, Panel, PrimaryButton, SecondaryButton, Strong } from "../components/Panel.tsx";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { FallbackView, StaleBanner } from "../components/StatusViews.tsx";
import { useEndpoint } from "../lib/api.ts";
import {
  runDeepEgressTest,
  useAction,
} from "../lib/consoleApi.ts";

/**
 * 诊断页 —— 服务进程内的分层检查（配置 → 存储 → Worker → Clash → 目录）。
 *
 * 能打开这一页说明服务层是通的，所以不再单列「服务」。网关停了的时候这一页
 * 打不开，那时用 `npm run doctor`。
 *
 * 深度出口测试会切换 Clash 分组的选中节点（进程外的全局状态），先确认；
 * 与批量探测互斥，服务端回 409 时在按钮旁说明原因。
 */
const LAYER_STATUS: Record<DiagnosticLayer["status"], { tone: StatusTone; icon: string; label: string }> = {
  pass: { tone: "success", icon: "✓", label: "通过" },
  warn: { tone: "warn", icon: "!", label: "警告" },
  fail: { tone: "error", icon: "✕", label: "失败" },
  skip: { tone: "neutral", icon: "○", label: "跳过" },
};

export function DiagnosticsPage() {
  const diag = useEndpoint<Diagnostics>("/api/diagnostics", DiagnosticsSchema, 15_000);
  if (diag.state.status !== "ready") return <FallbackView state={diag.state} />;
  return (
    <>
      <StaleBanner stale={diag.stale} />
      <DiagnosticsView data={diag.state.data} refresh={diag.refresh} />
    </>
  );
}

export function DiagnosticsView({ data, refresh }: { data: Diagnostics; refresh: () => void }) {
  const firstFail = data.layers.find((l) => l.status === "fail") ?? null;
  return (
    <div className="space-y-4">
      <Panel title="分层检查" action={<SecondaryButton onClick={refresh}>重新检查</SecondaryButton>}>
        {data.layers.length === 0 ? (
          <StatusIndicator tone="warn" icon="!" label="服务端没有返回任何检查层" />
        ) : (
          <StatusIndicator
            tone={firstFail === null ? (data.layers.some((l) => l.status === "warn") ? "warn" : "success") : "error"}
            icon={firstFail === null ? "✓" : "✕"}
            label={firstFail === null ? "没有失败的检查层" : `第一个失败层：${firstFail.title}`}
          />
        )}
        <ol className="mt-4 space-y-3">
          {data.layers.map((layer) => (
            <LayerItem key={layer.id} layer={layer} />
          ))}
        </ol>
      </Panel>
      <DeepEgressPanel />
    </div>
  );
}

function LayerItem({ layer }: { layer: DiagnosticLayer }) {
  const s = LAYER_STATUS[layer.status];
  const edge = { success: "border-l-success", warn: "border-l-warn", error: "border-l-error", neutral: "border-l-border-strong", info: "border-l-info" }[s.tone];
  return (
    <li className={`rounded-md border border-border-strong border-l-[3px] ${edge} px-4 py-3`} data-layer={layer.id}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{layer.title}</span>
        <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />
      </div>
      <p className="mt-1 max-w-3xl">{layer.summary}</p>
      {layer.details.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-text-muted">
          {layer.details.map((d, i) => (
            <li key={i} className="break-words">
              {d}
            </li>
          ))}
        </ul>
      )}
      {layer.nextStep !== undefined && layer.nextStep !== "" && (
        <p className="mt-2 max-w-3xl">
          <Strong>下一步：</Strong>
          {layer.nextStep}
        </p>
      )}
    </li>
  );
}

function DeepEgressPanel() {
  const deep = useAction(runDeepEgressTest);
  const [confirming, setConfirming] = useState(false);
  const running = deep.state.status === "running";
  return (
    <Panel
      title="深度出口测试"
      action={
        <PrimaryButton onClick={() => setConfirming(true)} disabled={running}>
          {running ? "测试中…" : "深度出口测试"}
        </PrimaryButton>
      }
    >
      <p className="max-w-3xl text-text-muted">
        对每个在用出口实测 IP 回显，结果写回配置并更新回显出口报告。回显服务可能与
        Zen 命中不同规则，只证明该回显目标的出口。
      </p>
      <div aria-live="polite" className="mt-3">
        {deep.state.status === "error" && (
          <div role="alert">
            <StatusIndicator
              tone="error"
              icon="✕"
              label={
                deep.state.httpStatus === 409
                  ? `批量探测正在运行，占用着 Clash 分组；等它结束或在代理池页取消后再试。（${deep.state.message}）`
                  : deep.state.message
              }
            />
          </div>
        )}
        {deep.state.status === "done" && (
          <div>
            <StatusIndicator
              tone={deep.state.data.results.every((r) => r.ok) ? "success" : "warn"}
              icon={deep.state.data.results.every((r) => r.ok) ? "✓" : "!"}
              label={`完成：${deep.state.data.results.filter((r) => r.ok).length}/${deep.state.data.results.length} 个出口成功${deep.state.data.changed ? "，已写回配置" : ""}`}
            />
            <ul className="mt-2 space-y-1">
              {deep.state.data.results.map((r) => (
                <li key={r.proxyId}>
                  <Mono>{r.proxyId}</Mono>：
                  {r.ok ? (
                    <>
                      <Mono>{r.egressIp}</Mono> · {r.latencyMs}ms
                    </>
                  ) : (
                    <span className="text-error">
                      {r.failureKind} —— {r.reason}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title="开始深度出口测试"
        confirmLabel="开始测试"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void deep.run();
        }}
      >
        <p>
          经 Clash 桥接的出口会逐个<Strong>切换 Clash 分组的选中节点</Strong>。那是 Clash 的全局状态：
          测试期间本机其他走这个分组的流量也会跟着换出口，结束后不会自动切回。
        </p>
        <p>批量探测运行时不能开始。</p>
      </ConfirmDialog>
    </Panel>
  );
}
