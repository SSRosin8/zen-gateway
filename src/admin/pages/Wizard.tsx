import type { Overview } from "../../shared/contract.ts";
import { Mono, Panel, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";

/**
 * 首启向导。
 *
 * ## 它只在「还不能用」时出现
 *
 * 判据是 `pool.total === 0`（没有任何在候选池里的 Worker）—— 那时转发**一定**
 * 失败，所以引导比任何统计都重要。配好之后它自动消失，不需要一个「关闭」按钮:
 * 一个能被关掉的向导会在用户误关后再也找不回来。
 *
 * ## 分步引导到「第一次成功生成」
 *
 * 规划要求的是这个 —— 不是一个功能清单。所以每一步都给**可直接跑的命令**
 * 与**可复制的配置**，并标出当前进行到哪一步（前面的步骤已完成就打勾）。
 *
 * ## Relay Token 不渲染进 DOM
 *
 * 它是凭证。向导给的是「去哪儿取」而不是值本身 —— 把它渲染出来等于让它进
 * 截图、进浏览器扩展、进 devtools 的保存。这与整个管理面同一条规则。
 */

type Step = {
  readonly done: boolean;
  readonly title: string;
  readonly body: React.ReactNode;
};

export function Wizard({ data }: { data: Overview }) {
  const hasProxy = data.proxies.total > 0;
  const hasWorker = data.workers.length > 0;
  const hasUsableWorker = data.pool.total > 0;
  const hasCatalog = data.catalog.freeCount !== null && data.catalog.freeCount > 0;

  const snippet = `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode": {
      "options": {
        "baseURL": "http://127.0.0.1:${data.gateway.port}/v1",
        "apiKey": "<data/config.json 里的 gateway.relayToken>"
      }
    }
  }
}`;

  const steps: Step[] = [
    {
      done: hasCatalog,
      title: "上游目录能拉到",
      body: hasCatalog ? (
        <p className="text-text-muted">
          已拉到 {data.catalog.freeCount} 个免费模型。
        </p>
      ) : (
        <>
          <p className="text-text-muted">
            目录拉不到的话免费判定没有依据，转发会被拒。最常见的成因是企业网络
            对 <Mono>opencode.ai</Mono> 做 TLS 中间人，而 <Strong>Node 不读系统 CA 库</Strong>
            （<Mono>curl</Mono> 读 —— 所以 curl 通不代表网关通）。
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
      done: hasProxy,
      title: "配出口代理",
      body: hasProxy ? (
        <p className="text-text-muted">
          已有 {data.proxies.total} 个代理，{data.proxies.withEgressIp} 个已实测出口 IP。
        </p>
      ) : (
        <>
          <p className="text-text-muted">
            出口隔离是这个工具存在的理由 —— 多个 Zen 账号必须从<Strong>不同的公网 IP</Strong>
            发出，否则有被上游判定关联的风险。一条命令自动探测本机 Clash 并导入节点：
          </p>
          <Cmd>npm run setup</Cmd>
        </>
      ),
    },
    {
      done: hasUsableWorker,
      title: "加 Worker（每个 Zen key 一个）",
      body: hasUsableWorker ? (
        <p className="text-text-muted">
          {data.pool.total} 个 Worker 在候选池里，{data.pool.ready} 个就绪。
        </p>
      ) : (
        <>
          <p className="text-text-muted">
            {hasWorker
              ? "已有 Worker 条目，但没有一个在候选池里 —— 多半是缺 API key 或被停用了。"
              : "转发需要真实的 Zen API key。"}
            <Strong>免 key 的匿名通道已被上游关闭</Strong>（403 <Mono>FreeTierError</Mono>），
            所以没有 key 的条目一个都不能用。
          </p>
          <p className="mt-2 text-text-muted">
            编辑 <Mono>data/config.json</Mono> 的 <Mono>workers</Mono> 数组，
            每个 key 一条，<Mono>proxyId</Mono> 绑不同的代理才有隔离意义：
          </p>
          <Cmd>{`{ "id": "w1", "kind": "authenticated", "apiKey": "<你的 key>", "proxyId": "<代理 id>" }`}</Cmd>
          <p className="mt-2 text-text-muted">
            改完跑 <Mono>npm run restart</Mono>（或用「代理池」页的批量探测实测出口）。
          </p>
        </>
      ),
    },
    {
      done: false,
      title: "把 OpenCode 指过来",
      body: (
        <>
          <p className="text-text-muted">
            覆盖内置的 <Mono>opencode</Mono> provider。放在{" "}
            <Mono>~/.config/opencode/opencode.json</Mono> 或项目根目录：
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">
            {snippet}
          </pre>
          <p className="mt-2 text-text-muted">
            然后验证 —— <Strong>只能用真实 OpenCode CLI，<Mono>curl</Mono> 不算</Strong>
            （免费闸门查请求<Strong>形态</Strong>不查 key，手搓 curl 必得 403）：
          </p>
          <Cmd>opencode run --model opencode/mimo-v2.6-flash-free &quot;Reply with exactly: OK&quot;</Cmd>
        </>
      ),
    },
  ];

  return (
    <Panel title="先把它跑起来">
      <div className="rounded-md bg-surface-accent px-4 py-3">
        <p className="font-serif text-lg">还不能转发</p>
        <p className="mt-1 text-text-muted">
          {hasWorker
            ? "有 Worker 条目，但没有一个能用。"
            : "还没有可用的 Worker —— 按下面几步配一遍。"}
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

/** 可直接跑的命令。等宽 + 独立一行 —— 它是要被复制的。 */
function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border border-border-strong bg-bg p-3 font-mono">
      {children}
    </pre>
  );
}
