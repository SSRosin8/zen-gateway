import { useState } from "react";
import { CopyButton } from "../components/CopyButton.tsx";
import type { OpenCodeView, Overview } from "../../shared/contract.ts";
import { FormStatus, Mono, PageHeader, Panel, SecondaryButton, errorMessage, type FormMessage } from "../components/Panel.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { OpenCodeConfigCard } from "../components/OpenCodeConfigCard.tsx";
import { LanAccessPanel } from "../components/LanAccess.tsx";
import { patchConfig, type FetchState } from "../lib/api.ts";
import { versionFromDetected, writeOpenCodeConfig } from "../lib/consoleApi.ts";
import { openCodeConfigSnippet, type OpenCodeVersion } from "../lib/openCodeConfig.ts";
import { FIELD } from "../lib/styles.ts";

/**
 * 客户端接入页 —— 客户端连到网关要的一切：Relay Token（含轮换）、项目 opencode.json、
 * 其他客户端的配置片段、局域网访问口令。运行参数与调度在网关页。
 *
 * ## OpenCode 配置由服务端写文件
 *
 * 服务端持有真实 Relay Token，写 `opencode.json` 时直接填进去；页面上只显示指纹。
 * 复制片段仍然保留给其他客户端，但片段里只有占位符 —— 把 token 渲染进 DOM
 * 等于让它进截图、进浏览器扩展、进 devtools 的保存。
 *
 * ## 轮换 Relay Token 之后要重写 opencode.json
 *
 * 轮换立即生效，旧 token 的客户端会拿到 401。确认框里默认勾选「同时写入 opencode.json」；
 * 没勾或写入失败时，服务端判据（`pointsToGateway`）让重写提示常驻，直到文件指向当前 token。
 */
export function ClientPage({
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
      <PageHeader title="客户端接入" />
      <TokenPanel data={data} refresh={refresh} opencode={opencode} />
      <OpenCodePanel opencode={opencode} refresh={refresh} port={data.gateway.port} />
      <LanAccessPanel />
    </div>
  );
}

function TokenPanel({
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
  /** 轮换后顺带重写 opencode.json；文件存在且能安全改写时默认勾选。 */
  const canRewrite = opencode.status === "ready" && opencode.data.exists && opencode.data.unwritableReason === null;
  const [alsoRewrite, setAlsoRewrite] = useState(true);

  const rotate = () => {
    setConfirming(false);
    setRotating(true);
    setMessage(null);
    const rewrite = canRewrite && alsoRewrite;
    void patchConfig({ gateway: { relayToken: { rotate: true } } })
      .then(async () => {
        if (!rewrite) {
          setMessage({ tone: "success", text: "已轮换，新 token 立即生效" });
          return;
        }
        const version = opencode.status === "ready" ? opencode.data.detectedVersion : null;
        try {
          await writeOpenCodeConfig(versionFromDetected(version));
          setMessage({ tone: "success", text: "已轮换，并已把新 token 写入 opencode.json" });
        } catch (err) {
          setMessage({ tone: "error", text: `已轮换，但 opencode.json 写入失败：${errorMessage(err)?.text ?? ""}` });
        }
      })
      .catch((err) => setMessage(errorMessage(err)))
      .finally(() => {
        setRotating(false);
        refresh?.();
      });
  };

  /*
   * 「opencode.json 仍是旧 token」由服务端判据驱动（`pointsToGateway` 比对当前 token），
   * 不用组件内的「刚轮换过」标记：换页、刷新或在别处轮换之后提示依然在。
   */
  const stale = opencode.status === "ready" && opencode.data.exists && !opencode.data.pointsToGateway;

  return (
    <Panel title="Relay Token">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-text-muted">客户端地址</dt>
        <dd>
          <Mono>http://127.0.0.1:{data.gateway.port}/v1</Mono>
          <span className="ml-2 text-text-muted">仅本机；局域网设备不能直接调用模型</span>
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
      </dl>
      <div className="mt-3 space-y-2" aria-live="polite">
        <FormStatus message={message} />
        {stale && <RewriteAfterRotate opencode={opencode} refresh={refresh} />}
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
        <p>正在使用旧 token 的客户端会收到 401，需要换成新 token。</p>
        {canRewrite ? (
          <label className="flex min-h-[44px] items-center gap-2 text-text">
            <input type="checkbox" checked={alsoRewrite} onChange={(e) => setAlsoRewrite(e.target.checked)} />
            同时把新 token 写入项目根 opencode.json
          </label>
        ) : (
          <p>项目根 opencode.json 不存在或不能自动改写，轮换后请手动更新客户端配置。</p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}

/** opencode.json 未指向本网关（常见于轮换之后）时的重写提示；版本沿用检测值。 */
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
      <p>opencode.json 没有指向本网关（多半还是旧 token），重写后 OpenCode 才能继续使用本网关。</p>
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
              className={FIELD}
            >
              <option value="2">OpenCode 2.x</option>
              <option value="1">OpenCode 1.x</option>
            </select>
          </label>
          <CopyButton text={snippet} />
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
