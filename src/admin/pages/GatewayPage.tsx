import { useState } from "react";
import type { OpenCodeView, Overview } from "../../shared/contract.ts";
import { FormStatus, Mono, Panel, SecondaryButton, errorMessage, type FormMessage } from "../components/Panel.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { OpenCodeConfigCard } from "../components/OpenCodeConfigCard.tsx";
import { RoutingSettingsForm, RuntimeSettingsForm } from "../components/GatewaySettingsForms.tsx";
import { patchConfig, type FetchState } from "../lib/api.ts";
import { versionFromDetected, writeOpenCodeConfig } from "../lib/consoleApi.ts";
import { openCodeConfigSnippet, type OpenCodeVersion } from "../lib/openCodeConfig.ts";

/**
 * 网关页 —— 连接信息、运行参数、调度、Relay Token 与客户端配置。
 *
 * ## OpenCode 配置由服务端写文件
 *
 * 服务端持有真实 Relay Token，写 `opencode.json` 时直接填进去；页面上只显示指纹。
 * 复制片段仍然保留给其他客户端，但片段里只有占位符 —— 把 token 渲染进 DOM
 * 等于让它进截图、进浏览器扩展、进 devtools 的保存。
 *
 * ## 轮换 Relay Token 之后要重写 opencode.json
 *
 * 轮换立即生效，旧 token 的客户端会拿到 401。所以成功后紧跟一个重写按钮，
 * 而不是让用户自己想起来。
 */
export { validateMaxAttempts } from "../components/GatewaySettingsForms.tsx";

export function GatewayPage({
  data,
  refresh,
  opencode = { status: "loading" },
}: {
  data: Overview;
  refresh?: () => void;
  opencode?: FetchState<OpenCodeView>;
}) {
  return (
    <div className="space-y-4">
      <ConnectionPanel data={data} refresh={refresh} opencode={opencode} />
      <OpenCodePanel opencode={opencode} refresh={refresh} port={data.gateway.port} />
      <RuntimeSettingsForm data={data} refresh={refresh} />
      <RoutingSettingsForm data={data} refresh={refresh} />
    </div>
  );
}

function ConnectionPanel({
  data,
  refresh,
  opencode,
}: {
  data: Overview;
  refresh?: (() => void) | undefined;
  opencode: FetchState<OpenCodeView>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const [rotated, setRotated] = useState(false);

  const rotate = () => {
    setConfirming(false);
    setRotating(true);
    setMessage(null);
    void patchConfig({ gateway: { relayToken: { rotate: true } } })
      .then(() => {
        setRotated(true);
        setMessage({ tone: "success", text: "已轮换，新 token 立即生效" });
        refresh?.();
      })
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => setRotating(false));
  };

  return (
    <Panel title="连接">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-text-muted">监听</dt>
        <dd>
          <Mono>127.0.0.1:{data.gateway.port}</Mono>
          <span className="ml-2 text-text-muted">仅回环，不对外监听</span>
        </dd>
        <dt className="text-text-muted">上游</dt>
        <dd>
          <Mono>{data.gateway.baseUrl}</Mono>
        </dd>
        <dt className="text-text-muted">Relay Token</dt>
        <dd className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {data.gateway.relayToken.present ? (
            <>
              <Mono>{data.gateway.relayToken.fingerprint}</Mono>
              <span className="text-text-muted">只显示指纹（供比对）</span>
            </>
          ) : (
            <span className="text-error">未配置，转发面会拒绝一切请求</span>
          )}
          <SecondaryButton onClick={() => setConfirming(true)} disabled={rotating}>
            {rotating ? "轮换中…" : "轮换 Relay Token"}
          </SecondaryButton>
        </dd>
        <dt className="text-text-muted">版本</dt>
        <dd>
          <Mono>v{data.health.version}</Mono>
          <span className="ml-2 text-text-muted">pid {data.health.pid}</span>
        </dd>
      </dl>
      <div className="mt-3 space-y-2" aria-live="polite">
        <FormStatus message={message} />
        {rotated && <RewriteAfterRotate opencode={opencode} refresh={refresh} />}
      </div>

      <ConfirmDialog
        open={confirming}
        title="轮换 Relay Token"
        confirmLabel="确认轮换"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={rotate}
      >
        <p>服务端会生成新的 Relay Token 并立即生效，旧 token 随即失效。</p>
        <p>正在使用旧 token 的客户端（包括现有的 opencode.json）会收到 401，需要重写配置。</p>
      </ConfirmDialog>
    </Panel>
  );
}

/** 轮换成功后紧跟的重写提示；版本沿用检测值。 */
function RewriteAfterRotate({
  opencode,
  refresh,
}: {
  opencode: FetchState<OpenCodeView>;
  refresh?: (() => void) | undefined;
}) {
  const [state, setState] = useState<FormMessage>(null);
  const [busy, setBusy] = useState(false);
  const exists = opencode.status === "ready" && opencode.data.exists;
  return (
    <div className="rounded-md border border-warn bg-surface-accent px-4 py-3" data-rewrite-prompt="">
      <p>opencode.json 里还是旧 token，重写后 OpenCode 才能继续使用本网关。</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setState(null);
            const version = opencode.status === "ready" ? opencode.data.detectedVersion : null;
            void writeOpenCodeConfig(versionFromDetected(version))
              .then(() => {
                setState({ tone: "success", text: "已重写 opencode.json" });
                refresh?.();
              })
              .catch((err) => setState(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "写入中…" : exists ? "重写 opencode.json" : "写入 opencode.json"}
        </SecondaryButton>
        <FormStatus message={state} />
      </div>
    </div>
  );
}

function OpenCodePanel({
  opencode,
  refresh,
  port,
}: {
  opencode: FetchState<OpenCodeView>;
  refresh?: (() => void) | undefined;
  port: number;
}) {
  return (
    <Panel title="OpenCode 项目配置">
      <OpenCodeConfigCard status={opencode} onWritten={() => refresh?.()} />
      <OtherClientSnippet port={port} />
    </Panel>
  );
}

/** 给其他客户端或全局配置用的片段；token 只有占位符。 */
function OtherClientSnippet({ port }: { port: number }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [version, setVersion] = useState<OpenCodeVersion>("2");
  const snippet = openCodeConfigSnippet(port, version);
  return (
    <details className="mt-4 border-t border-border-strong pt-3" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="min-h-[44px] cursor-pointer content-center text-text-muted hover:text-text">
        其他客户端或全局配置：复制片段
      </summary>
      <div className="mt-2 space-y-2">
        <p className="max-w-3xl text-text-muted">
          放在 <Mono>~/.config/opencode/opencode.json</Mono> 或其他项目里；把占位符换成 <Mono>data/config.json</Mono> 里的{" "}
          <Mono>gateway.relayToken</Mono>。
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">片段格式</span>
            <select
              aria-label="片段格式"
              value={version}
              onChange={(e) => setVersion(e.target.value as OpenCodeVersion)}
              className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
            >
              <option value="2">OpenCode 2.x</option>
              <option value="1">OpenCode 1.x</option>
            </select>
          </label>
          <SecondaryButton
            onClick={() => {
              void navigator.clipboard?.writeText(snippet).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "已复制" : "复制"}
          </SecondaryButton>
        </div>
        <pre className="overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">{snippet}</pre>
        <p className="max-w-3xl text-text-muted">
          {version === "1" ? (
            <>
              OpenCode 1.x 使用单数 <Mono>provider</Mono> 与 <Mono>options</Mono>
            </>
          ) : (
            <>
              OpenCode 2.x 使用复数 <Mono>providers</Mono> 与 <Mono>settings</Mono>
            </>
          )}
          ，只覆盖内置 <Mono>opencode</Mono> provider 的 <Mono>baseURL</Mono> 与 <Mono>apiKey</Mono>；模型和 SDK 由
          OpenCode 自己管理。你选择的模型仍受上游权限与免费规则约束。
        </p>
      </div>
    </details>
  );
}
