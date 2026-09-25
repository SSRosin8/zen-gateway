import { HealthSchema, poolHealth, type PoolHealth } from "../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "./components/StatusIndicator.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { useOverview } from "./lib/api.ts";

/**
 * 应用外壳。
 *
 * Phase 9 批次 1 只有 Overview 一页 —— 其余 5 页（Gateway / ProxyPool /
 * Workers / Models / Usage）在后续批次。导航暂不渲染：一个只有一个条目的
 * 标签栏是噪音，而**留一个指向空页面的入口比没有入口更糟**（用户会点进去
 * 发现什么都没有，然后怀疑是不是坏了）。
 *
 * URL 承载视图状态（规划要求「URL 是页面状态的唯一来源」）也留到有多页时 ——
 * 现在只有一页，`/#overview` 与 `/` 等价，加一个路由器只是为了将来。
 */

const POOL_TONE: Record<PoolHealth, StatusTone> = {
  empty: "neutral",
  healthy: "success",
  degraded: "warn",
};

const POOL_LABEL: Record<PoolHealth, string> = {
  empty: "尚未配置 Worker",
  healthy: "全部就绪",
  degraded: "部分就绪",
};

const POOL_ICON: Record<PoolHealth, string> = { empty: "○", healthy: "✓", degraded: "!" };

export function App() {
  const { state } = useOverview();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        {/* wordmark 是衬线真能生效的地方之一（纯拉丁）。 */}
        <h1 className="font-serif text-3xl leading-none tracking-tight">zen-gateway</h1>
        <p className="mt-2 text-text-muted">OpenCode Zen 免费模型本地网关</p>
      </header>

      {state.status === "ready" ? (
        <OverviewPage data={state.data} />
      ) : (
        <FallbackView state={state} />
      )}
    </main>
  );
}

/**
 * 非就绪态。
 *
 * ## 三种失败必须分开，它们的下一步完全不同
 *
 * | 态 | 含义 | 下一步 |
 * |---|---|---|
 * | `loading` | 首次请求在途 | 等 |
 * | `offline` | 连接被拒 —— 网关没在跑 | `npm start` |
 * | `error` | 连上了但响应不对 | 多半是前后端版本不一致 → `npm run build` |
 *
 * 合成一句「加载失败」会让用户去猜。这与 `doctor` 分层同一个理由：
 * 诊断的价值在于下一步，不在于报告失败。
 *
 * **空池仍然显示「尚未配置 Worker」而不是「全部就绪」** —— 全新安装时
 * Worker 数为 0，朴素写法 `ready === total` 得到 `0 === 0` 为真。
 * 这条契约由 `poolHealth` 的 `empty` 第三态保证，而这里在**拿不到数据时**
 * 也要成立：首次加载还没有任何数字，此时绝不能显示成功态。
 */
function FallbackView({
  state,
}: {
  state: { status: "loading" } | { status: "offline" } | { status: "error"; message: string };
}) {
  // 拿不到数据时按空池渲染 —— 绝不在没有数字的情况下显示「全部就绪」。
  const pool = poolHealth({ ready: 0, total: 0 });

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border-strong bg-surface p-5">
        <h2 className="mb-4 text-base font-medium">服务</h2>
        {state.status === "loading" && (
          <StatusIndicator tone="neutral" icon="○" label="检测中" />
        )}
        {state.status === "offline" && (
          <>
            <StatusIndicator tone="error" icon="✕" label="未连接到网关服务" />
            <p className="mt-3 text-text-muted">
              网关没在运行。跑 <code className="font-mono text-accent-fg">npm start</code> 启动它。
            </p>
          </>
        )}
        {state.status === "error" && (
          <>
            <StatusIndicator tone="error" icon="✕" label="响应异常" />
            <p className="mt-3 text-text-muted">{state.message}</p>
          </>
        )}
      </section>

      <section className="rounded-lg border border-border-strong bg-surface p-5">
        <h2 className="mb-4 text-base font-medium">Worker 池</h2>
        <StatusIndicator tone={POOL_TONE[pool]} icon={POOL_ICON[pool]} label={POOL_LABEL[pool]} />
        <p className="mt-3 text-text-muted">
          还没有可用出口。运行 <code className="font-mono text-accent-fg">npm run setup</code> 自动配置。
        </p>
      </section>
    </div>
  );
}

/** 供测试引用 —— 契约在 `shared/contract.ts`，这里只是转出。 */
export { HealthSchema };
