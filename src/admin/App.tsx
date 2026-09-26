import { useEffect, useState } from "react";
import {
  HealthSchema,
  ModelListSchema,
  ProxyListSchema,
  StatsViewSchema,
  type ModelList,
  type Overview,
  type ProxyList,
  type StatsView,
} from "../shared/contract.ts";
import { StatusIndicator } from "./components/StatusIndicator.tsx";
import { Nav } from "./components/Nav.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { GatewayPage } from "./pages/GatewayPage.tsx";
import { ProxyPage } from "./pages/ProxyPage.tsx";
import { WorkersPage } from "./pages/WorkersPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
import { Wizard, WizardNotice } from "./pages/Wizard.tsx";
import { useEndpoint, useOverview, type FetchState, type StaleInfo } from "./lib/api.ts";
import { useViewState, type PageId } from "./lib/router.ts";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "./lib/theme.ts";
import { humanMs } from "./lib/format.ts";

/**
 * 应用外壳。
 *
 * ## 六页 + 首启向导
 *
 * 导航从 `PAGES` 推导（那份清单也是路由分派的真相），URL 是视图状态的
 * **唯一来源** —— 页面、标签、搜索词、筛选、页码全部在 hash 里，
 * 刷新与分享都还原同一视图。
 *
 * ## `overview` 始终在轮询，其余页按需拉
 *
 * Overview 的数据（健康、Worker 状态、隔离）是每一页都要的 —— 断连横幅、
 * 向导的判据都读它，所以它常驻。代理列表、模型列表、统计只在对应页面打开时
 * 才拉：没人看的页面不该让后台一直查库。
 *
 * ## 断连时保留页面
 *
 * 首次加载之后的轮询失败不卸载页面，只在顶部显示一条横幅（见 `StaleBanner`），
 * 否则网关重启的几秒里未保存的表单会随页面一起丢失。
 */

/** 向导在这些页面完整显示；其余页面只给一行提示，不把正文往下推。 */
const WIZARD_PAGES: ReadonlySet<PageId> = new Set(["overview", "workers", "gateway"]);

export function App() {
  const { view, navigate } = useViewState();
  const overview = useOverview();
  const { state } = overview;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {/* wordmark 是衬线真能生效的地方之一（纯拉丁）。 */}
          <h1 className="font-serif text-3xl leading-none tracking-tight">zen-gateway</h1>
          <p className="mt-2 text-text-muted">OpenCode Zen 免费模型本地网关</p>
        </div>
        <ThemeSelect />
      </header>

      <Nav current={view.page} />

      <StaleBanner stale={overview.stale} />

      {state.status === "ready" ? (
        <Body
          data={state.data}
          view={view}
          navigate={navigate}
          refresh={overview.refresh}
          overviewStale={overview.stale !== null}
        />
      ) : (
        <FallbackView state={state} />
      )}
    </main>
  );
}

function ThemeSelect() {
  const { preference, setPreference } = useTheme();
  return (
    <label className="flex items-center gap-2 text-text-muted">
      <span>配色</span>
      <select
        value={preference}
        onChange={(e) => setPreference(e.target.value as ThemePreference)}
        className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3 text-text"
      >
        {THEME_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 当前时刻，每秒更新一次；只在需要显示「N 秒前」时挂载。 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * 与网关的连接中断，但之前拿到过数据。
 *
 * 不阻断页面：数据仍然显示，表单仍然可填，只是用户要知道看到的不是现在。
 * `role="status"` 而不是 alert —— 每秒更新的秒数不该反复打断屏幕阅读器。
 */
export function StaleBanner({ stale }: { stale: StaleInfo | null }) {
  if (stale === null) return null;
  return <StaleBannerInner stale={stale} />;
}

function StaleBannerInner({ stale }: { stale: StaleInfo }) {
  const now = useNow();
  const age = humanMs(Math.max(0, now - stale.lastSuccessAt));
  return (
    <div
      role="status"
      className="mb-4 rounded-md border border-warn bg-surface-accent px-4 py-3"
    >
      <StatusIndicator
        tone="warn"
        icon="!"
        label={`与网关的连接中断，显示的是 ${age}前的数据`}
      />
      <p className="mt-1 text-text-muted">
        {stale.failure.kind === "offline" ? (
          <>
            网关可能已停止。运行 <code className="font-mono text-accent-fg">npm start</code>{" "}
            后会自动恢复；未保存的表单内容会保留。
          </>
        ) : (
          <>最近一次请求失败：{stale.failure.message}</>
        )}
      </p>
    </div>
  );
}

function Body({
  data,
  view,
  navigate,
  refresh,
  overviewStale,
}: {
  data: Overview;
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
  refresh: () => void;
  /** 页头已经显示了断连横幅时，子页面不再重复显示自己的。 */
  overviewStale: boolean;
}) {
  /*
   * 没有可用 Worker 时显示向导。
   *
   * 那时转发一定失败，所以引导比任何统计都重要。不做成可关闭的：一个能被
   * 关掉的向导会在用户误关后再也找不回来 —— 而它的出现条件（`pool.total === 0`）
   * 本身就是「配好了就消失」。只在与配置相关的页面完整显示，其他页面给一行提示。
   */
  const needsWizard = data.pool.total === 0;
  const [createRequest, setCreateRequest] = useState(0);
  const openCreateWorker = () => {
    setCreateRequest((n) => n + 1);
    navigate({ page: "workers" });
  };

  return (
    <div className="space-y-4">
      {needsWizard &&
        (WIZARD_PAGES.has(view.page) ? (
          <Wizard data={data} onCreateWorker={openCreateWorker} />
        ) : (
          <WizardNotice />
        ))}

      {view.page === "overview" && <OverviewPage data={data} />}
      {view.page === "gateway" && <GatewayPage data={data} refresh={refresh} />}
      {view.page === "workers" && (
        <WorkersTab
          data={data}
          view={view}
          navigate={navigate}
          refresh={refresh}
          createRequest={createRequest}
        />
      )}
      {view.page === "proxy" && <ProxyTab view={view} navigate={navigate} hideStale={overviewStale} />}
      {view.page === "models" && <ModelsTab view={view} navigate={navigate} hideStale={overviewStale} />}
      {view.page === "usage" && <UsageTab hideStale={overviewStale} />}
    </div>
  );
}

/**
 * Worker 页额外拉代理列表，供出口下拉框使用。
 *
 * 代理列表失败不挡住 Worker 页：Worker 数据来自 overview，编辑器在拿不到
 * 代理列表时退回文本输入并说明原因。
 */
function WorkersTab({
  data,
  view,
  navigate,
  refresh,
  createRequest,
}: {
  data: Overview;
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
  refresh: () => void;
  createRequest: number;
}) {
  const proxies = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema, 30_000);
  return (
    <WorkersPage
      data={data}
      view={view}
      navigate={navigate}
      refresh={refresh}
      proxies={proxies.state}
      createRequest={createRequest}
    />
  );
}

/** 代理池页的数据在它自己的端点上 —— 只在这一页打开时才拉。 */
function ProxyTab({
  view,
  navigate,
  hideStale,
}: {
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
  hideStale: boolean;
}) {
  const { state, stale } = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={hideStale ? null : stale} />
      <ProxyPage data={state.data} view={view} navigate={navigate} />
    </>
  );
}

function ModelsTab({
  view,
  navigate,
  hideStale,
}: {
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
  hideStale: boolean;
}) {
  /*
   * 模型目录以天为单位变化，所以 30s 一次够了。保存判定设置后立即刷新
   * 这个端点本身 —— 判定结果在这里，不在 overview 里。
   */
  const { state, refresh, stale } = useEndpoint<ModelList>("/api/models", ModelListSchema, 30_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={hideStale ? null : stale} />
      <ModelsPage data={state.data} view={view} navigate={navigate} refresh={refresh} />
    </>
  );
}

function UsageTab({ hideStale }: { hideStale: boolean }) {
  /*
   * 时间窗是这一页自己的状态，不进 URL：搜索词/页码是「我在看列表的哪一部分」，
   * 分享链接时要带上；时间窗更像一个显示选项，且只对这一页有意义。
   */
  const [days, setDays] = useState("30");
  const { state, stale } = useEndpoint<StatsView>(`/api/stats?days=${days}`, StatsViewSchema, 10_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={hideStale ? null : stale} />
      <UsagePage data={state.data} days={days} onDays={setDays} />
    </>
  );
}

/**
 * 首次加载的非就绪态。
 *
 * ## 三种失败必须分开，它们的下一步完全不同
 *
 * | 态 | 含义 | 下一步 |
 * |---|---|---|
 * | `loading` | 首次请求在途 | 等 |
 * | `offline` | 连接被拒 —— 网关没在跑 | `npm start` |
 * | `error` | 连上了但响应不对 | 多半是前后端版本不一致 → `npm run build` |
 *
 * 合成一句「加载失败」会让用户去猜。
 *
 * 这里**不替 Worker 池说话**：拿不到数据时不知道池的状态，显示「尚未配置
 * Worker」会让一个装好的系统看起来要重装；显示「全部就绪」则是把未知当成功。
 */
function FallbackView({ state }: { state: FetchState<unknown> }) {
  return (
    <section className="rounded-lg border border-border-strong bg-surface p-5">
      <h2 className="mb-4 text-base font-medium">服务</h2>
      {state.status === "loading" && <StatusIndicator tone="neutral" icon="○" label="检测中" />}
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
  );
}

/** 供测试引用 —— 契约在 `shared/contract.ts`，这里只是转出。 */
export { HealthSchema };
