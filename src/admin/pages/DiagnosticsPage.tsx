import { DiagnosticsSchema, type DiagnosticLayer, type Diagnostics } from "../../shared/contract.ts";
import { PageHeader, Panel, SecondaryButton, SecondaryLink, Strong } from "../components/Panel.tsx";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { FallbackView, StaleBanner } from "../components/StatusViews.tsx";
import { useEndpoint } from "../lib/api.ts";

/**
 * 诊断页 —— 服务进程内的分层检查（配置 → 存储 → Worker → Clash → 目录）。
 *
 * 能打开这一页说明服务层是通的，所以不再单列「服务」。网关停了的时候这一页
 * 打不开，那时用 `npm run doctor`。
 *
 * 出口实测不在这里做：它会切换 Clash 分组的选中节点，放在 Worker 页与出口页，与批量探测互斥。
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
      <PageHeader title="诊断" action={<SecondaryButton onClick={refresh}>重新检查</SecondaryButton>} />
      <Panel title="分层检查">
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
      <EgressHint />
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
          {LAYER_LINK[layer.id] !== undefined && layer.status !== "pass" && (
            <a href={LAYER_LINK[layer.id]!.href} className="ml-2 text-accent-fg underline">
              {LAYER_LINK[layer.id]!.label}
            </a>
          )}
        </p>
      )}
    </li>
  );
}

/**
 * 各层「下一步」对应的页面。诊断只指路，不在这里重复一份操作：出口探测在 Worker 页，
 * 目录与免费规则在模型页。
 */
const LAYER_LINK: Partial<Record<DiagnosticLayer["id"], { label: string; href: string }>> = {
  workers: { label: "去 Worker 页", href: "#workers" },
  clash: { label: "去出口页的 Clash 标签", href: "#proxy?tab=clash" },
  catalog: { label: "去模型页", href: "#models" },
};

function EgressHint() {
  return (
    <Panel
      title="出口实测"
      hint="Worker 页的「探测在用出口」逐个进行，结果标在每个 Worker 上，离开页面也不中断；出口页的批量探测覆盖出口池里全部已启用节点。"
    >
      <div className="flex flex-wrap gap-2">
        <SecondaryLink href="#workers">去 Worker 页探测</SecondaryLink>
        <SecondaryLink href="#proxy">去出口页批量探测</SecondaryLink>
      </div>
    </Panel>
  );
}
