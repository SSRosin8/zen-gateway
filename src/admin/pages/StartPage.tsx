import { useState, type ReactNode } from "react";
import type { OpenCodeView, Overview } from "../../shared/contract.ts";
import { Mono, Panel, SecondaryButton, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { ClashImportFlow } from "../components/ClashImportFlow.tsx";
import { OpenCodeConfigCard } from "../components/OpenCodeConfigCard.tsx";
import type { FetchState } from "../lib/api.ts";

/**
 * 快速开始 —— 首启引导，一页走完从零到第一次成功生成。
 *
 * ## 每一步都是实时判据，不是勾选框
 *
 * 判据全部来自服务端状态（overview 与 `/api/opencode`）：用户在别的页面配好了，
 * 这里也跟着打勾。没有「标记为完成」按钮：能被手动勾掉的步骤会掩盖真实问题。
 *
 * ## 哪些步骤决定「完成」
 *
 * 目录、Worker、OpenCode 配置三项必需。Clash 出口是可选项：不用代理时 Worker
 * 走本机直连也能工作，它计入进度但不阻止完成。最后的验证只能由真实 OpenCode
 * CLI 完成，网关无法替用户判定，所以不计入进度。
 */
export type OnboardingStepId = "catalog" | "clash" | "workers" | "opencode";

export type OnboardingProgress = {
  readonly steps: Readonly<Record<OnboardingStepId, boolean>>;
  readonly done: number;
  readonly total: number;
  /** 必需步骤是否全部完成。 */
  readonly complete: boolean;
};

const REQUIRED: readonly OnboardingStepId[] = ["catalog", "workers", "opencode"];

export function onboardingProgress(data: Overview, opencode: FetchState<OpenCodeView>): OnboardingProgress {
  const steps: Record<OnboardingStepId, boolean> = {
    catalog: data.catalog.freeCount !== null && data.catalog.freeCount > 0,
    clash: data.proxies.total > 0,
    workers: data.pool.total > 0,
    // 拿不到状态时不算完成：未知不能显示成成功。
    opencode: opencode.status === "ready" && opencode.data.pointsToGateway,
  };
  const ids = Object.keys(steps) as OnboardingStepId[];
  return {
    steps,
    done: ids.filter((id) => steps[id]).length,
    total: ids.length,
    complete: REQUIRED.every((id) => steps[id]),
  };
}

export const VERIFY_COMMAND = 'opencode run --model opencode/big-pickle "Reply with exactly: OK"';

export function StartPage({
  data,
  opencode,
  refresh,
  onCreateWorker,
  onBulkImport,
}: {
  data: Overview;
  opencode: FetchState<OpenCodeView>;
  refresh: () => void;
  onCreateWorker: () => void;
  onBulkImport: () => void;
}) {
  const progress = onboardingProgress(data, opencode);
  const { steps } = progress;

  return (
    <div className="space-y-4">
      <Panel title="快速开始">
        <StatusIndicator
          tone={progress.complete ? "success" : "neutral"}
          icon={progress.complete ? "✓" : "○"}
          label={
            progress.complete
              ? "必需步骤都已完成，可以用 OpenCode 验证"
              : `已完成 ${progress.done}/${progress.total} 步`
          }
        />
        <p className="mt-2 max-w-3xl text-text-muted">
          每一步的状态来自网关的实时数据：在其他页面改好的设置，这里也会打勾。
        </p>
      </Panel>

      <ol className="space-y-4">
        <Step n={1} id="catalog" done={steps.catalog} title="上游目录可达">
          {steps.catalog ? (
            <p className="text-text-muted">已拉到 {data.catalog.freeCount} 个免费模型。</p>
          ) : (
            <>
              <p className="max-w-3xl text-text-muted">
                {data.catalog.freeCount === 0
                  ? "目录可达，但当前免费集为空；到模型页检查免费规则。"
                  : "还没拉到上游目录。最常见的成因是企业网络对 opencode.ai 做 TLS 中间人，而 Node 不读系统 CA 库，需要在启动网关时指定："}
              </p>
              {data.catalog.freeCount !== 0 && <Cmd text="NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start" />}
              <p className="mt-2 text-text-muted">
                <a href="#diagnostics" className="text-accent-fg underline">
                  诊断页
                </a>{" "}
                会逐层检查服务进程的证书、出口与目录。
              </p>
            </>
          )}
        </Step>

        <Step n={2} id="clash" done={steps.clash} title="导入 Clash 出口（可选）">
          <p className="mb-3 max-w-3xl text-text-muted">
            {steps.clash
              ? `已有 ${data.proxies.total} 个出口代理。可以再次探测导入，已导入的节点会更新而不是重复。`
              : "不配代理时 Worker 走本机直连。要让不同 Worker 使用不同出口，从本机 Clash 导入节点："}
          </p>
          <ClashImportFlow onImported={refresh} />
        </Step>

        <Step n={3} id="workers" done={steps.workers} title="创建 Worker">
          <p className="max-w-3xl text-text-muted">
            {steps.workers
              ? `${data.pool.total} 个 Worker 在候选池里，${data.pool.ready} 个就绪。`
              : data.workers.length > 0
                ? "已有 Worker 条目，但没有一个在候选池里：多半是被停用了，或认证 Worker 缺少 API key。"
                : "匿名 Worker 不需要 key；认证 Worker 填你自己的 Zen API key。保存后立即生效。"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <SecondaryButton onClick={onCreateWorker}>新增 Worker</SecondaryButton>
            {data.proxies.total > 0 && (
              <SecondaryButton onClick={onBulkImport}>从 Clash 节点导入匿名 Worker</SecondaryButton>
            )}
          </div>
        </Step>

        <Step n={4} id="opencode" done={steps.opencode} title="OpenCode 项目配置">
          <OpenCodeConfigCard
            status={opencode}
            onWritten={refresh}
            /* 前三步完成、只差这一步时，写入是本页唯一的主操作。 */
            primary={steps.catalog && steps.workers && !steps.opencode}
          />
        </Step>

        <li className="rounded-lg border border-border-strong bg-surface px-4 py-4 sm:px-5" data-step="verify">
          <StatusIndicator tone="neutral" icon="5" label="用 OpenCode 验证" />
          <div className="mt-2 pl-6">
            <p className="max-w-3xl text-text-muted">
              在<Strong>网关项目根目录</Strong>运行（<Mono>opencode.json</Mono> 在这里）。
              只有真实客户端的请求能证明链路通，<Mono>curl</Mono> 的请求形态不同，不能替代：
            </p>
            <Cmd text={VERIFY_COMMAND} copyable />
          </div>
        </li>
      </ol>
    </div>
  );
}

function Step({
  n,
  id,
  done,
  title,
  children,
}: {
  n: number;
  id: OnboardingStepId;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="rounded-lg border border-border-strong bg-surface px-4 py-4 sm:px-5" data-step={id} data-done={done ? "" : undefined}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-heading-16 font-medium">
          {n}. {title}
        </span>
        <StatusIndicator tone={done ? "success" : "neutral"} icon={done ? "✓" : "○"} label={done ? "已完成" : "待完成"} />
      </div>
      <div className="mt-3">{children}</div>
    </li>
  );
}

/** 可直接跑的命令。等宽 + 独立一行；`copyable` 时带复制按钮。 */
export function Cmd({ text, copyable = false }: { text: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">{text}</pre>
      {copyable && (
        <SecondaryButton
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "已复制" : "复制命令"}
        </SecondaryButton>
      )}
    </div>
  );
}
