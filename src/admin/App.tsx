import { useEffect, useRef, useState } from "react";
import {
  HealthSchema,
  ModelListSchema,
  OpenCodeViewSchema,
  ProxyListSchema,
  StatsViewSchema,
  type ModelList,
  type OpenCodeView,
  type Overview,
  type ProxyList,
  type StatsView,
} from "../shared/contract.ts";
import { Shell } from "./components/Shell.tsx";
import { FallbackView, StaleBanner } from "./components/StatusViews.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { GatewayPage } from "./pages/GatewayPage.tsx";
import { ClientPage } from "./pages/ClientPage.tsx";
import { ProxyPage } from "./pages/ProxyPage.tsx";
import { WorkersPage } from "./pages/WorkersPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { USAGE_RANGES, UsagePage, formatUsageView, parseUsageView } from "./pages/UsagePage.tsx";
import { StartPage, onboardingProgress } from "./pages/StartPage.tsx";
import { DiagnosticsPage } from "./pages/DiagnosticsPage.tsx";
import { useEndpoint, useOverview, useProbe, type FetchState, type Polled, type ProbeRun } from "./lib/api.ts";
import { useViewState } from "./lib/router.ts";

/**
 * 应用外壳。
 *
 * ## 侧栏 + 快速开始
 *
 * 导航从 `PAGES` 推导（那份清单也是路由分派的真相），URL 是视图状态的
 * **唯一来源** —— 页面、标签、搜索词、筛选、页码全部在 hash 里。
 * 首启未完成且 URL 没有指定页面时落到快速开始；指定了页面就尊重 URL。
 *
 * ## `overview` 与 OpenCode 状态常驻轮询，其余页按需拉
 *
 * 断连横幅与快速开始的进度都读这两个端点，所以它们常驻。代理列表、模型列表、
 * 统计、诊断只在对应页面打开时才拉：没人看的页面不该让后台一直查库。
 *
 * ## 断连时保留页面
 *
 * 首次加载之后的轮询失败不卸载页面，只在顶部显示一条横幅（见 `StaleBanner`），
 * 否则网关重启的几秒里未保存的表单会随页面一起丢失。
 */
export function App() {
  const { view, navigate } = useViewState();
  const overview = useOverview();
  const opencode = useEndpoint<OpenCodeView>("/api/opencode", OpenCodeViewSchema, 10_000);
  const { state } = overview;

  /*
   * 出口探测归 App 所有：离开概览页后循环照常进行，进度与逐行结果不能随页面卸载丢失。
   * 侧栏显示进行中的任务，点一下回到概览。
   */
  const probe = useProbe(overview.refresh);

  const progress = state.status === "ready" ? onboardingProgress(state.data, opencode.state) : null;
  useLandOnStart(progress, opencode.state.status === "loading", () => navigate({ page: "start" }));

  return (
    <Shell
      current={view.page}
      badge={progress === null || progress.complete ? null : `${progress.done}/${progress.total}`}
      version={state.status === "ready" ? state.data.health.version : null}
      task={probe.running ? { label: `探测出口 ${probe.done}/${probe.total ?? 0}`, href: "#workers" } : null}
    >
      <StaleBanner stale={overview.stale} />
      {state.status === "ready" ? (
        <Body
          data={state.data}
          opencode={opencode}
          view={view}
          navigate={navigate}
          refresh={overview.refresh}
          overviewStale={overview.stale !== null}
          probe={probe}
        />
      ) : (
        <FallbackView state={state} />
      )}
    </Shell>
  );
}

/**
 * 首次打开且 URL 没指定页面时，首启未完成就落到快速开始。
 *
 * 只判定一次：之后用户点到概览不该被拉回来。OpenCode 状态还在途时等它，
 * 否则判据少一项，会把已完成的首启误判为未完成。
 */
function useLandOnStart(
  progress: { complete: boolean } | null,
  opencodePending: boolean,
  goStart: () => void,
) {
  const pending = useRef(typeof window !== "undefined" && window.location.hash.replace(/^#\/?/, "") === "");
  useEffect(() => {
    if (!pending.current || progress === null || opencodePending) return;
    pending.current = false;
    // 等待期间用户可能已经点了导航，那时 URL 已有页面，尊重它。
    if (window.location.hash.replace(/^#\/?/, "") !== "") return;
    if (!progress.complete) goStart();
  }, [progress, opencodePending, goStart]);
}

type ViewProps = {
  view: ReturnType<typeof useViewState>["view"];
  navigate: ReturnType<typeof useViewState>["navigate"];
};

function Body({
  data,
  opencode,
  view,
  navigate,
  refresh,
  overviewStale,
  probe,
}: ViewProps & {
  data: Overview;
  opencode: Polled<OpenCodeView>;
  refresh: () => void;
  probe: ProbeRun;
  /** 页头已经显示了断连横幅时，子页面不再重复显示自己的。 */
  overviewStale: boolean;
}) {
  const refreshAll = () => {
    refresh();
    opencode.refresh();
  };

  return (
    <div className="space-y-4">
      {view.page === "start" && (
        <StartTab data={data} opencode={opencode.state} refresh={refreshAll} />
      )}
      {view.page === "overview" && (
        <OverviewTab data={data} opencode={opencode.state} />
      )}
      {view.page === "gateway" && <GatewayPage data={data} refresh={refreshAll} />}
      {view.page === "client" && <ClientPage data={data} refresh={refreshAll} opencode={opencode.state} />}
      {view.page === "workers" && (
        <WorkersTab data={data} view={view} navigate={navigate} refresh={refresh} probe={probe} />
      )}
      {view.page === "proxy" && (
        <ProxyTab view={view} navigate={navigate} hideStale={overviewStale} refreshOverview={refresh} />
      )}
      {view.page === "models" && <ModelsTab view={view} navigate={navigate} hideStale={overviewStale} />}
      {view.page === "usage" && <UsageTab view={view} navigate={navigate} hideStale={overviewStale} />}
      {view.page === "diagnostics" && <DiagnosticsPage />}
    </div>
  );
}

/**
 * Worker 页额外拉代理列表，供出口下拉框与批量导入使用。
 *
 * 代理列表失败不挡住 Worker 页：Worker 数据来自 overview，编辑器在拿不到
 * 代理列表时退回文本输入并说明原因。
 */
function WorkersTab({
  data,
  view,
  navigate,
  refresh,
  probe,
}: ViewProps & { data: Overview; refresh: () => void; probe: ProbeRun }) {
  const proxies = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema, 30_000);
  // 详情侧栏里的用量：只在打开详情时拉（30 天窗口）。
  const stats = useEndpoint<StatsView>(view.detail === null ? null : "/api/stats?days=30", StatsViewSchema, 30_000);
  return (
    <WorkersPage
      probe={probe}
      stats={stats.state.status === "ready" ? stats.state.data : null}
      data={data}
      view={view}
      navigate={navigate}
      refresh={() => {
        refresh();
        proxies.refresh();
      }}
      proxies={proxies.state}
    />
  );
}

/** 概览额外拉近 1 天的统计，只用来数网关拒绝（「需要处理」里的一条）。 */
function OverviewTab({ data, opencode }: { data: Overview; opencode: FetchState<OpenCodeView> }) {
  const recent = useEndpoint<StatsView>("/api/stats?days=1", StatsViewSchema, 60_000);
  return <OverviewPage data={data} opencode={opencode} recent={recent.state.status === "ready" ? recent.state.data : null} />;
}

/**
 * 快速开始就地新建 Worker（单个或从 Clash 节点批量），需要代理列表做出口下拉与候选。
 * 用户不必跳到 Worker 页再回来，引导的上下文不丢。
 */
function StartTab({ data, opencode, refresh }: { data: Overview; opencode: FetchState<OpenCodeView>; refresh: () => void }) {
  const proxies = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema, 30_000);
  /*
   * 只为回答「请求到过网关没有」：一旦看到就锁存并停止轮询 —— 之后统计表越来越大，
   * 每 10 秒跑一遍 30 天聚合只为一个不会再变的布尔值。没请求之前表是空的，轮询很便宜。
   */
  const [seen, setSeen] = useState(false);
  const stats = useEndpoint<StatsView>(seen ? null : "/api/stats?days=30", StatsViewSchema, 10_000);
  const seenNow = stats.state.status === "ready" && stats.state.data.requests > 0;
  useEffect(() => {
    if (seenNow) setSeen(true);
  }, [seenNow]);
  return (
    <StartPage
      seenRequests={seen || seenNow ? true : stats.state.status === "ready" ? false : null}
      data={data}
      opencode={opencode}
      proxies={proxies.state}
      refresh={() => {
        refresh();
        proxies.refresh();
      }}
    />
  );
}

/** 出口页的数据在它自己的端点上 —— 只在这一页打开时才拉。 */
function ProxyTab({
  view,
  navigate,
  hideStale,
  refreshOverview,
}: ViewProps & { hideStale: boolean; refreshOverview: () => void }) {
  const { state, stale, refresh } = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={stale} hidden={hideStale} />
      <ProxyPage
        data={state.data}
        view={view}
        navigate={navigate}
        refresh={() => {
          refresh();
          refreshOverview();
        }}
      />
    </>
  );
}

function ModelsTab({ view, navigate, hideStale }: ViewProps & { hideStale: boolean }) {
  /*
   * 模型目录以天为单位变化，所以 30s 一次够了。保存判定设置后立即刷新
   * 这个端点本身 —— 判定结果在这里，不在 overview 里。
   */
  const { state, refresh, stale } = useEndpoint<ModelList>("/api/models", ModelListSchema, 30_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={stale} hidden={hideStale} />
      <ModelsPage data={state.data} view={view} navigate={navigate} refresh={refresh} />
    </>
  );
}

function UsageTab({ view, navigate, hideStale }: ViewProps & { hideStale: boolean }) {
  /* 时间范围、系列、图形与指标都在 URL 里（`status` 存时间范围，`view` 存图表视图）：分享链接即同一张图。 */
  const days = USAGE_RANGES.find((r) => r.value === view.status)?.value ?? "30";
  const usageView = parseUsageView(view.view);
  const { state, stale, refresh } = useEndpoint<StatsView>(`/api/stats?days=${days}`, StatsViewSchema, 10_000);
  if (state.status !== "ready") return <FallbackView state={state} />;
  return (
    <>
      <StaleBanner stale={stale} hidden={hideStale} />
      <UsagePage
        data={state.data}
        days={days}
        onDays={(next) => navigate({ status: next === "30" ? null : next })}
        view={usageView}
        onView={(next) => navigate({ view: formatUsageView(next) })}
        onReset={refresh}
      />
    </>
  );
}

/** 供测试引用 —— 契约在 `shared/contract.ts`，这里只是转出。 */
export { HealthSchema };
export { StaleBanner };
