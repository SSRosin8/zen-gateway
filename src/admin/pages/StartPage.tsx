import { useState, type ReactNode } from "react";
import type { OpenCodeView, Overview, ProxyList } from "../../shared/contract.ts";
import { FormStatus, Mono, SecondaryButton, Strong, errorMessage, type FormMessage } from "../components/Panel.tsx";
import { WorkerEditor } from "../components/WorkerEditor.tsx";
import { BulkImportDialog } from "../components/BulkImportDialog.tsx";
import { patchConfig } from "../lib/api.ts";
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
  proxies,
}: {
  data: Overview;
  opencode: FetchState<OpenCodeView>;
  refresh: () => void;
  /** 出口下拉与批量导入的数据源；新增 Worker 就在本页完成，不跳走。 */
  proxies?: FetchState<ProxyList>;
}) {
  const progress = onboardingProgress(data, opencode);
  const { steps } = progress;
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const [created, setCreated] = useState<FormMessage>(null);
  const existingIds = data.workers.map((w) => w.id);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-heading-20 font-medium">快速开始</h1>
        <StatusIndicator
          tone={progress.complete ? "success" : "neutral"}
          icon={progress.complete ? "✓" : "○"}
          label={
            progress.complete
              ? "必需步骤都已完成，可以用 OpenCode 验证"
              : `已完成 ${progress.done}/${progress.total} 步`
          }
        />
        <span className="text-text-muted">状态来自网关实时数据，在其他页面改好的设置这里也会打勾。</span>
      </header>

      <ol className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <Step n={1} id="catalog" done={steps.catalog} title="上游目录可达">
          {steps.catalog ? (
            <p className="text-text-muted">已拉到 {data.catalog.freeCount} 个免费模型。</p>
          ) : data.catalog.freeCount === 0 ? (
            <p className="text-text-muted">目录可达，但当前免费集为空；到模型页检查免费规则。</p>
          ) : (
            <>
              <p className="text-text-muted">
                还没拉到上游目录。最常见的成因是企业网络对 opencode.ai 做 TLS 中间人，而 Node 不读系统 CA
                库，需要在启动网关时指定证书；
                <a href="#diagnostics" className="text-accent-fg underline">诊断页</a>
                会逐层检查服务进程的证书、出口与目录。
              </p>
              <Cmd text="NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start" />
            </>
          )}
        </Step>

        <Step n={2} id="clash" done={steps.clash} title="导入 Clash 出口" optional>
          <p className="mb-3 text-text-muted">
            {steps.clash
              ? `已有 ${data.proxies.total} 个出口代理。再次导入会更新已有节点，不会重复。`
              : "不配代理时 Worker 走本机直连。要让不同 Worker 使用不同出口，从本机 Clash 导入节点。"}
          </p>
          <ClashImportFlow onImported={refresh} onCreateWorkers={() => setBulkOpen(true)} />
        </Step>

        <Step n={3} id="workers" done={steps.workers} title="创建 Worker">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="text-text-muted">
              {steps.workers
                ? `${data.pool.total} 个 Worker 在候选池里，${data.pool.ready} 个就绪。`
                : data.workers.length > 0
                  ? "已有 Worker 条目，但没有一个在候选池里：多半是被停用了，或认证 Worker 缺少 API key。"
                  : "匿名 Worker 不需要 key；认证 Worker 填你自己的 Zen API key。保存后立即生效。"}
            </p>
            <span className="flex flex-wrap gap-2">
              <SecondaryButton
                onClick={() => {
                  setMessage(null);
                  setCreated(null);
                  setCreating((v) => !v);
                }}
              >
                {creating ? "收起" : "新增 Worker"}
              </SecondaryButton>
              {data.proxies.total > 0 && (
                <SecondaryButton onClick={() => setBulkOpen(true)}>从 Clash 节点导入匿名 Worker</SecondaryButton>
              )}
            </span>
            <FormStatus message={created} />
          </div>
          {creating && (
            <div className="mt-3 border-t border-border pt-3">
              <WorkerEditor
                mode="create"
                existingIds={existingIds}
                saving={saving}
                proxies={proxies}
                message={message}
                onCancel={() => setCreating(false)}
                onSave={async (patch) => {
                  setSaving(true);
                  setMessage(null);
                  try {
                    await patchConfig(patch);
                    setCreating(false);
                    setCreated({ tone: "success", text: "已新增，立即生效" });
                    refresh();
                  } catch (err) {
                    setMessage(errorMessage(err));
                  } finally {
                    setSaving(false);
                  }
                }}
              />
            </div>
          )}
          <BulkImportDialog
            open={bulkOpen}
            proxies={proxies}
            existingIds={existingIds}
            onClose={() => setBulkOpen(false)}
            onDone={(n) => {
              setBulkOpen(false);
              setCreated({ tone: "success", text: `已从 Clash 节点新建 ${n} 个匿名 Worker` });
              refresh();
            }}
          />
        </Step>

        <Step n={4} id="opencode" done={steps.opencode} title="OpenCode 项目配置">
          <OpenCodeConfigCard
            status={opencode}
            onWritten={refresh}
            /* 前三步完成、只差这一步时，写入是本页唯一的主操作。 */
            primary={steps.catalog && steps.workers && !steps.opencode}
          />
        </Step>

        <Step n={5} id="verify" done={null} title="用 OpenCode 验证">
          <p className="text-text-muted">
            在<Strong>网关项目根目录</Strong>运行（<Mono>opencode.json</Mono> 在这里）。只有真实客户端的请求能证明链路通，
            <Mono>curl</Mono> 的请求形态不同，不能替代：
          </p>
          <Cmd text={VERIFY_COMMAND} copyable />
        </Step>
      </ol>
    </div>
  );
}

/**
 * 一步：宽屏左列是编号、标题与状态，右列是内容，同一页的所有步骤共用列宽，
 * 标题与内容各自对齐；窄屏上下排。`done` 为 null 表示这一步没有网关可判定的状态。
 */
function Step({
  n,
  id,
  done,
  title,
  optional = false,
  children,
}: {
  n: number;
  id: OnboardingStepId | "verify";
  done: boolean | null;
  title: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className="grid gap-x-8 gap-y-3 border-b border-border-strong px-4 py-4 last:border-b-0 sm:px-5 lg:grid-cols-[15rem_minmax(0,1fr)]"
      data-step={id}
      data-done={done === true ? "" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:flex-col lg:items-start">
        <span className="text-heading-16 font-medium">
          {n}. {title}
          {optional && <span className="ml-2 text-label-13 font-normal text-text-muted">可选</span>}
        </span>
        {done !== null && (
          <StatusIndicator tone={done ? "success" : "neutral"} icon={done ? "✓" : "○"} label={done ? "已完成" : "待完成"} />
        )}
      </div>
      <div className="min-w-0">{children}</div>
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
