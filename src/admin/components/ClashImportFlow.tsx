import { useState } from "react";
import type { ClashControllerView, ClashImportResponse } from "../../shared/contract.ts";
import { FormStatus, Mono, SecondaryButton, Strong } from "./Panel.tsx";
import { StatusIndicator } from "./StatusIndicator.tsx";
import {
  discoverClash,
  importClash,
  useAction,
} from "../lib/consoleApi.ts";

/**
 * Clash 探测与导入 —— 快速开始与代理池页共用同一个组件。
 *
 * 流程：探测本机控制面 → 选一个 → 「预览」（`dryRun: true`）看会增改什么 →
 * 「导入」写入配置，立即生效。必须先预览再导入：导入会新增 Clash 内核并批量
 * 写入节点，用户应先看到数字再决定。
 *
 * 按钮都用描边：这个组件嵌在别的视图里，主操作归所在页面。
 */
export function ClashImportFlow({ onImported }: { onImported?: () => void }) {
  const discover = useAction(discoverClash);
  const preview = useAction(importClash);
  const apply = useAction(importClash);
  const [manualBase, setManualBase] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const controllers = discover.state.status === "done" ? discover.state.data.controllers : null;
  const chosen = controllers?.find((c) => c.apiBase === selected) ?? null;
  const secretOf = (base: string) => secrets[base] ?? "";
  const body = (dryRun: boolean) => {
    const secret = chosen === null ? "" : secretOf(chosen.apiBase);
    return { apiBase: chosen?.apiBase ?? "", dryRun, ...(secret === "" ? {} : { secret }) };
  };

  const runDiscover = async () => {
    preview.reset();
    apply.reset();
    const base = manualBase.trim();
    const result = await discover.run(base === "" ? {} : { apiBase: base });
    const first = result?.controllers.find((c) => c.status !== "unreachable");
    setSelected(first?.apiBase ?? null);
  };

  return (
    <div className="space-y-3" data-clash-import="">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[16rem] flex-col gap-1">
          <span className="text-text-muted">控制面地址（留空自动探测本机常见端口）</span>
          <input
            value={manualBase}
            onChange={(e) => setManualBase(e.target.value)}
            placeholder="http://127.0.0.1:9097"
            className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
          />
        </label>
        <SecondaryButton onClick={() => void runDiscover()} disabled={discover.state.status === "running"}>
          {discover.state.status === "running" ? "探测中…" : "探测 Clash"}
        </SecondaryButton>
      </div>

      <FormStatus message={discover.state.status === "error" ? { tone: "error", text: discover.state.message } : null} />

      {controllers !== null && controllers.length === 0 && (
        <StatusIndicator tone="warn" icon="!" label="没有探测到本机 Clash 控制面，填写地址后重试" />
      )}

      {controllers !== null && controllers.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-text-muted">探测到的控制面</legend>
          {controllers.map((c) => (
            <ControllerRow
              key={c.apiBase}
              controller={c}
              checked={selected === c.apiBase}
              onSelect={() => {
                setSelected(c.apiBase);
                preview.reset();
                apply.reset();
              }}
              secret={secretOf(c.apiBase)}
              onSecret={(v) => setSecrets((prev) => ({ ...prev, [c.apiBase]: v }))}
            />
          ))}
        </fieldset>
      )}

      {chosen !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton
            onClick={() => {
              apply.reset();
              void preview.run(body(true));
            }}
            disabled={preview.state.status === "running" || apply.state.status === "running"}
          >
            {preview.state.status === "running" ? "预览中…" : "预览"}
          </SecondaryButton>
          <SecondaryButton
            onClick={() => void apply.run(body(false)).then((r) => r !== null && onImported?.())}
            /* 先预览再导入：用户要先看到会写入什么。 */
            disabled={preview.state.status !== "done" || apply.state.status === "running"}
          >
            {apply.state.status === "running" ? "导入中…" : "导入"}
          </SecondaryButton>
          {preview.state.status !== "done" && <span className="text-text-muted">先预览，确认后再导入</span>}
        </div>
      )}

      <div aria-live="polite" className="space-y-2">
        {preview.state.status === "error" && <FormStatus message={{ tone: "error", text: preview.state.message }} />}
        {preview.state.status === "done" && apply.state.status !== "done" && (
          <ImportSummary result={preview.state.data} />
        )}
        {apply.state.status === "error" && <FormStatus message={{ tone: "error", text: apply.state.message }} />}
        {apply.state.status === "done" && <ImportSummary result={apply.state.data} />}
      </div>
    </div>
  );
}

function ControllerRow({
  controller: c,
  checked,
  onSelect,
  secret,
  onSecret,
}: {
  controller: ClashControllerView;
  checked: boolean;
  onSelect: () => void;
  secret: string;
  onSecret: (v: string) => void;
}) {
  const disabled = c.status === "unreachable";
  const status =
    c.status === "ok"
      ? { tone: "success" as const, icon: "✓", label: "可连接" }
      : c.status === "auth_required"
        ? { tone: "warn" as const, icon: "!", label: "需要 secret" }
        : { tone: "error" as const, icon: "✕", label: c.reason ?? "无法连接" };
  return (
    <div className="rounded-md border border-border-strong px-3 py-2" data-controller={c.apiBase}>
      <label className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1">
        <input type="radio" name="clash-controller" checked={checked} disabled={disabled} onChange={onSelect} />
        <Mono>{c.apiBase}</Mono>
        <StatusIndicator {...status} />
        {c.status !== "unreachable" && (
          <span className="text-text-muted">
            {[
              c.version !== undefined ? `版本 ${c.version}` : null,
              c.mode !== undefined ? `模式 ${c.mode}` : null,
              c.mixedPort != null ? `mixed-port ${c.mixedPort}` : null,
              c.selectorGroup !== undefined ? `分组 ${c.selectorGroup}` : null,
              c.nodeCount !== undefined ? `${c.nodeCount} 个节点` : null,
            ]
              .filter((x) => x !== null)
              .join(" · ")}
          </span>
        )}
      </label>
      {c.status === "auth_required" && (
        <label className="mt-2 flex flex-col gap-1">
          <span className="text-text-muted">控制面 secret</span>
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => onSecret(e.target.value)}
            className="min-h-[44px] max-w-sm rounded-sm border border-border-strong bg-bg px-3"
          />
        </label>
      )}
    </div>
  );
}

function ImportSummary({ result }: { result: ClashImportResponse }) {
  const s = result.summary;
  return (
    <div data-import-summary={result.dryRun ? "preview" : "applied"}>
      <StatusIndicator
        tone={result.dryRun ? "info" : "success"}
        icon={result.dryRun ? "○" : "✓"}
        label={result.dryRun ? "预览（尚未写入）" : "已导入，立即生效"}
      />
      <p className="mt-1">
        内核 新增 <Mono>{s.bridgesAdded}</Mono> · 更新 <Mono>{s.bridgesUpdated}</Mono>；节点 新增{" "}
        <Mono>{s.proxiesAdded}</Mono> · 更新 <Mono>{s.proxiesUpdated}</Mono>
        ；分组 <Mono>{s.selectorGroup}</Mono>；代理端口 <Mono>{s.mixedPort}</Mono>
      </p>
      {s.warnings.length > 0 && (
        <ul className="mt-1 space-y-1">
          {s.warnings.map((w) => (
            <li key={w}>
              <StatusIndicator tone="warn" icon="!" label={w} />
            </li>
          ))}
        </ul>
      )}
      {!result.dryRun && (
        <p className="mt-1 text-text-muted">
          导入只写出口与内核，<Strong>不创建 Worker</Strong>；到 Worker 页从节点批量创建。
        </p>
      )}
    </div>
  );
}
