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
import { ProxyPage } from "./pages/ProxyPage.tsx";
import { WorkersPage } from "./pages/WorkersPage.tsx";
import { ModelsPage } from "./pages/ModelsPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
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
      task={probe.running ? { label: `探测出口 ${probe.done}/${probe.total ?? 0}`, href: "#overview" } : null}
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
        <OverviewPage data={data} page={view.page_} onPage={(next) => navigate({ page_: next })} probe={probe} />
      )}
      {view.page === "gateway" && <GatewayPage data={data} refresh={refreshAll} opencode={opencode.state} />}
      {view.page === "workers" && (
        <WorkersTab
          data={data}
          view={view}
          navigate={navigate}
          refresh={refresh}
        />
      )}
      {view.page === "proxy" && (
        <ProxyTab view={view} navigate={navigate} hideStale={overviewStale} refreshOverview={refresh} />
      )}
      {view.page === "models" && <ModelsTab view={view} navigate={navigate} hideStale={overviewStale} />}
      {view.page === "usage" && <UsageTab hideStale={overviewStale} />}
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
}: ViewProps & { data: Overview; refresh: () => void }) {
  const proxies = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema, 30_000);
  return (
    <WorkersPage
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

/**
 * 快速开始就地新建 Worker（单个或从 Clash 节点批量），需要代理列表做出口下拉与候选。
 * 用户不必跳到 Worker 页再回来，引导的上下文不丢。
 */
function StartTab({ data, opencode, refresh }: { data: Overview; opencode: FetchState<OpenCodeView>; refresh: () => void }) {
  const proxies = useEndpoint<ProxyList>("/api/proxies", ProxyListSchema, 30_000);
  return (
    <StartPage
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

/** 代理池页的数据在它自己的端点上 —— 只在这一页打开时才拉。 */
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
      <StaleBanner stale={hideStale ? null : stale} />
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

/** 供测试引用 —— 契约在 `shared/contract.ts`，这里只是转出。 */
export { HealthSchema };
export { StaleBanner };
