import { useState } from "react";
import {
  HealthSchema,
  ModelListSchema,
  ProxyListSchema,
  StatsViewSchema,
  poolHealth,
  type ModelList,
  type Overview,
  type PoolHealth,
  type ProxyList,
  type StatsView,
} from "../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "./components/StatusIndicator.tsx";
import { Nav } from "./components/Nav.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { GatewayPage } from "./pages/GatewayPage.tsx";
import { ProxyPage } from "./pages/ProxyPage.tsx";
import { WorkersPage } from "./pages/WorkersPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
import { Wizard } from "./pages/Wizard.tsx";
import { useEndpoint, useOverview, type FetchState } from "./lib/api.ts";
import { useViewState } from "./lib/router.ts";

/**
 * 应用外壳。
 *
 * ## 六页 + 首启向导
 *
 * 导航从 `PAGES` 推导（那份清单也是路由分派的真相），URL 是视图状态的
 * **唯一来源** —— 页面、标签、搜索词、筛选、页码全部在 hash 里，
 * 刷新与分享都还原同一视图。那是**新增能力**：把页面状态存在内存里的话，
 * 刷新即丢。
 *
 * ## `overview` 始终在轮询，其余页按需拉
 *
 * Overview 的数据（健康、Worker 状态、隔离）是**每一页的页头都要的**
 * —— 导航栏下面那个「未连接」提示、向导的判据都读它。所以它常驻。
 * 而代理列表、模型列表、统计只在对应页面打开时才拉:一次轮询三个端点
 * 会让后台在没人看的时候也一直查库。
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
  const { view, navigate } = useViewState();
  const { state } = useOverview();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        {/* wordmark 是衬线真能生效的地方之一（纯拉丁）。 */}
        <h1 className="font-serif text-3xl leading-none tracking-tight">zen-gateway</h1>
        <p className="mt-2 text-text-muted">OpenCode Zen 免费模型本地网关</p>
      </header>

      <Nav current={view.page} onNavigate={(page) => navigate({ page })} />

      {state.status === "ready" ? (
        <Body data={state.data} view={view} navigate={navigate} />
      ) : (
        /* 概览页:这里确实一个数字都没有,所以「尚未配置 Worker」是诚实的。 */
        <FallbackView state={state} showPool />
      )}
    </main>
  );
}

function Body({
  data,
  view,
  navigate,
}: {
  data: Overview;
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
}) {
  /*
   * 没有可用 Worker 时**任何页面之前先显示向导**。
   *
   * 那时转发一定失败，所以引导比任何统计都重要。不做成可关闭的:
   * 一个能被关掉的向导会在用户误关后再也找不回来 —— 而它的出现条件
   * （`pool.total === 0`）本身就是「配好了就消失」。
   */
  const needsWizard = data.pool.total === 0;

  return (
    <div className="space-y-4">
      {needsWizard && <Wizard data={data} />}

      {view.page === "overview" && <OverviewPage data={data} />}
      {view.page === "gateway" && <GatewayPage data={data} />}
      {view.page === "workers" && <WorkersPage data={data} view={view} navigate={navigate} />}
      {view.page === "proxy" && <ProxyTab view={view} navigate={navigate} />}
      {view.page === "models" && <ModelsTab view={view} navigate={navigate} />}
      {view.page === "usage" && <UsageTab />}
    </div>
  );
}

/** 代理池页的数据在它自己的端点上 —— 只在这一页打开时才拉。 */
function ProxyTab({
  view,
  navigate,
}: {
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
}) {
  const { state } = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return <ProxyPage data={state.data} view={view} navigate={navigate} />;
}

function ModelsTab({
  view,
  navigate,
}: {
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
}) {
  /*
   * 模型目录以**天**为单位变化，所以 30s 一次够了 —— 与 Overview 的 3s
   * 不同：那一页的数字（冷却剩余）以秒变化。用同一个间隔会让这一页
   * 每 3 秒重算一次 80 个模型的免费判定，而结果几小时都不变。
   */
  const { state } = useEndpoint<ModelList>("/api/models", ModelListSchema, 30_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return <ModelsPage data={state.data} view={view} navigate={navigate} />;
}

function UsageTab() {
  /*
   * 时间窗是这一页**自己**的状态，不进 URL。
   *
   * 与搜索词/页码不同：那些是「我在看列表的哪一部分」，分享链接时要带上；
   * 而时间窗更像一个显示选项。把它塞进 URL 会让 `?days=` 与其他页面的
   * `?status=` 混在同一个命名空间里，而它只对一个页面有意义。
   */
  const [days, setDays] = useState("30");
  const { state } = useEndpoint<StatsView>(`/api/stats?days=${days}`, StatsViewSchema, 10_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return <UsagePage data={state.data} days={days} onDays={setDays} />;
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
 *
 * ## `showPool` 为什么必须由调用方决定
 *
 * 那个「尚未配置 Worker / 运行 npm run setup」面板只在**概览页首次加载**时成立
 * —— 那时确实一个数字都没有。子页面（代理池/模型/用量）各有自己的端点，
 * 而**概览的数字可能已经拿到了**:它们讲的是同一个 Worker 池。
 *
 * 不区分的后果是实测出来的:池 1/1 健康、`/api/proxies` 还在飞的时候进代理池页,
 * 界面同时显示「检测中」和「尚未配置 Worker · 还没有可用出口,运行 npm run setup」
 * —— 后两句都是假的,而它让一个装好的系统看起来需要重新装一遍。
 * 第八轮审核查出。所以子页面传 `showPool={false}`:它们不知道池的状态,
 * 就不该替池说话。
 */
function FallbackView({
  state,
  showPool = false,
}: {
  state: FetchState<unknown>;
  /** 是否渲染 Worker 池面板。只有概览页该给 true —— 见上文。 */
  showPool?: boolean;
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

      {showPool && state.status !== "ready" && (
        <section className="rounded-lg border border-border-strong bg-surface p-5">
          <h2 className="mb-4 text-base font-medium">Worker 池</h2>
          <StatusIndicator tone={POOL_TONE[pool]} icon={POOL_ICON[pool]} label={POOL_LABEL[pool]} />
          <p className="mt-3 text-text-muted">
            还没有可用出口。运行 <code className="font-mono text-accent-fg">npm run setup</code> 自动配置。
          </p>
        </section>
      )}
    </div>
  );
}

/** 供测试引用 —— 契约在 `shared/contract.ts`，这里只是转出。 */
export { HealthSchema };
