import { useState } from "react";
import type { Overview } from "../../shared/contract.ts";
import { Mono, Panel, SecondaryButton, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { openCodeConfigSnippet, type OpenCodeVersion } from "../lib/openCodeConfig.ts";

/**
 * 首启向导。
 *
 * ## 它只在「还不能用」时出现
 *
 * 判据是 `pool.total === 0`（没有任何在候选池里的 Worker）—— 那时转发**一定**
 * 失败。配好之后它自动消失，不需要「关闭」按钮：一个能被关掉的向导会在用户
 * 误关后再也找不回来。
 *
 * ## 分步引导到「第一次成功生成」
 *
 * 每一步给可直接执行的操作（按钮、命令或可复制的配置），并标出已完成的步骤。
 * Worker 在 Worker 页创建并立即生效，不需要编辑配置文件或重启；
 * `npm run setup` 只导入出口代理与 Clash 内核，不创建 Worker。
 *
 * ## Relay Token 不渲染进 DOM
 *
 * 它是凭证。向导给的是「去哪儿取」而不是值本身 —— 把它渲染出来等于让它进
 * 截图、进浏览器扩展、进 devtools 的保存。
 */

type Step = {
  readonly done: boolean;
  readonly title: string;
  readonly body: React.ReactNode;
};

export function Wizard({ data, onCreateWorker }: { data: Overview; onCreateWorker: () => void }) {
  const hasProxy = data.proxies.total > 0;
  const hasWorker = data.workers.length > 0;
  const hasUsableWorker = data.pool.total > 0;
  const hasCatalog = data.catalog.freeCount !== null && data.catalog.freeCount > 0;

  const [openCodeVersion, setOpenCodeVersion] = useState<OpenCodeVersion>("2");
  const snippet = openCodeConfigSnippet(data.gateway.port, openCodeVersion);

  const steps: Step[] = [
    {
      done: hasCatalog,
      title: "上游目录能拉到",
      body: hasCatalog ? (
        <p className="text-text-muted">已拉到 {data.catalog.freeCount} 个免费模型。</p>
      ) : (
        <>
          <p className="text-text-muted">
            目录拉不到时页面无法确认在架模型，转发会按本地免费规则继续尝试，并在响应中标记
            未核验。最常见的成因是企业网络对 <Mono>opencode.ai</Mono> 做 TLS 中间人，而
            <Strong>Node 不读系统 CA 库</Strong>（<Mono>curl</Mono> 读 —— 所以 curl 通不代表网关通）。
          </p>
          <Cmd>NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start</Cmd>
          <p className="mt-2 text-text-muted">
            跑 <Mono>npm run doctor</Mono> 会直接告诉你是不是这个原因 ——
            它查的是<Strong>服务进程</Strong>的环境变量，不是你当前 shell 的。
          </p>
        </>
      ),
    },
    {
      done: hasUsableWorker,
      title: "新增 Worker",
      body: hasUsableWorker ? (
        <p className="text-text-muted">
          {data.pool.total} 个 Worker 在候选池里，{data.pool.ready} 个就绪。
        </p>
      ) : (
        <>
          <p className="text-text-muted">
            {hasWorker
              ? "已有 Worker 条目，但没有一个在候选池里 —— 多半是被停用了，或认证 Worker 缺少 API key。"
              : "在 Worker 页新增一个 Worker，保存后立即生效，不需要重启。"}{" "}
            匿名 Worker 可以不填 key；认证 Worker 需要填写你自己的 Zen API key。
          </p>
          <div className="mt-2">
            {/* 次按钮：向导与所在页面同屏，页面自己的主操作仍是唯一的主按钮。 */}
            <SecondaryButton onClick={onCreateWorker}>
              {hasWorker ? "去 Worker 页检查" : "去新增 Worker"}
            </SecondaryButton>
          </div>
        </>
      ),
    },
    {
      done: hasProxy,
      title: "可选：配置出口代理",
      body: hasProxy ? (
        <p className="text-text-muted">
          已有 {data.proxies.total} 个代理，{data.proxies.withEgressIp} 个已实测回显出口 IP。
          在 Worker 编辑表单里选择出口即可绑定。
        </p>
      ) : (
        <>
          <p className="text-text-muted">
            不配代理时 Worker 走本机直连。要让不同 Worker 使用不同出口，先导入本机 Clash
            的节点（只导入代理与 Clash 内核，不创建 Worker），重启后在 Worker 编辑表单里选择出口：
          </p>
          <Cmd>{"npm run setup\nnpm run restart"}</Cmd>
        </>
      ),
    },
    {
      done: false,
      title: "把 OpenCode 指过来",
      body: (
        <>
          <p className="text-text-muted">
            选择你的 OpenCode 主版本，生成覆盖本地网关的 <Mono>opencode</Mono> provider 配置。放在{" "}
            <Mono>~/.config/opencode/opencode.json</Mono> 或项目根目录：
          </p>
          <label className="mt-2 flex w-fit flex-col gap-1">
            <span className="text-text-muted">OpenCode 配置格式</span>
            <select
              aria-label="OpenCode 版本"
              value={openCodeVersion}
              onChange={(event) => setOpenCodeVersion(event.target.value as OpenCodeVersion)}
              className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3"
            >
              <option value="2">OpenCode 2.x（默认）</option>
              <option value="1">OpenCode 1.x</option>
            </select>
          </label>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">
            {snippet}
          </pre>
          <p className="mt-2 text-text-muted">
            {openCodeVersion === "1" ? (
              <>
                OpenCode 1.x 使用单数 <Mono>provider</Mono> 与 <Mono>options</Mono>，只覆盖已有
                provider 的 <Mono>baseURL</Mono> 与 <Mono>apiKey</Mono>；模型和 SDK 由 OpenCode
                自己管理。
              </>
            ) : (
              <>
                OpenCode 2.x 使用复数 <Mono>providers</Mono>，只覆盖已有 <Mono>opencode</Mono>{" "}
                provider 的 <Mono>settings.baseURL</Mono> 与 <Mono>settings.apiKey</Mono>；模型和
                SDK 由 OpenCode 自己管理。
              </>
            )}{" "}你选择的模型不保证都能被上游接受。
          </p>
          <p className="mt-2 text-text-muted">
            然后用真实 OpenCode CLI 验证当前可用的免费 Chat 模型。<Mono>curl</Mono>
            的请求形态不同，不能替代客户端验收：
          </p>
          <Cmd>opencode run --model opencode/big-pickle &quot;Reply with exactly: OK&quot;</Cmd>
        </>
      ),
    },
  ];

  return (
    <Panel title="先把它跑起来">
      <div className="rounded-md bg-surface-accent px-4 py-3">
        <p className="font-serif text-lg">还不能转发</p>
        <p className="mt-1 text-text-muted">
          {hasWorker ? "有 Worker 条目，但没有一个能用。" : "还没有可用的 Worker —— 按下面几步配一遍。"}
        </p>
      </div>

      <ol className="mt-4 space-y-5">
        {steps.map((step, i) => (
          <li key={step.title} data-step={i + 1}>
            <div className="flex items-baseline gap-2">
              <StatusIndicator
                tone={step.done ? "success" : "neutral"}
                icon={step.done ? "✓" : String(i + 1)}
                label={step.title}
              />
            </div>
            <div className="mt-1 pl-6">{step.body}</div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** 向导不完整显示的页面上的一行提示。 */
export function WizardNotice() {
  return (
    <div className="rounded-md border border-border-strong bg-surface px-4 py-3" role="status">
      <StatusIndicator tone="warn" icon="!" label="还没有可用的 Worker，转发会失败。" />{" "}
      <a href="#overview" className="text-accent-fg underline">
        去概览页查看首启步骤
      </a>
    </div>
  );
}

/** 可直接跑的命令。等宽 + 独立一行 —— 它是要被复制的。 */
function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">
      {children}
    </pre>
  );
}
