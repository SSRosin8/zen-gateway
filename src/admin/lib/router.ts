/**
 * URL 是视图状态的**唯一来源**。
 *
 * 页面、标签、搜索词、状态筛选、排序、页码全部编码进 URL
 * （`/#proxy?tab=clash&q=hk&status=ready&sort=latency&page=2`），
 * 刷新与分享都还原同一视图。
 *
 * ## 为什么用 hash 而不是 History API
 *
 * 后台构建产物由网关进程在后台端口伺服（`src/server/adminSite.ts`），开发时由 Vite 伺服。
 * 用 `pushState` 做 `/proxy` 这种路径的话，刷新会向服务器请求 `/proxy`，两边都得各做
 * SPA fallback；hash 路由刷新只请求 `/`，不依赖任何一边的回退规则。
 * 于是同一份前端在两种部署下行为不同，且差异只在「用户刷新页面」时暴露。
 *
 * hash 不参与服务端路由，两种部署下都成立。代价是 URL 里多一个 `#`，
 * 对一个本机工具可以忽略。
 *
 * ## 为什么不用 react-router
 *
 * 需要的全部功能是「读写 hash + 订阅变化」，实现是下面这几十行。
 * 一个路由库要带来它自己的一套概念（loader、嵌套路由、Outlet），
 * 而这里只有几个平级页面。
 */

import { useCallback, useEffect, useState } from "react";

/**
 * 侧栏分组与页面，按显示顺序。**这份清单是唯一真相** —— 导航、路由分派与 `PAGES` 都从它推导。
 * 分组参照「资源 / 设置 / 运行」：日常最常用的 Worker 与出口在前，设置类居中，观测类在后。
 */
export const NAV_GROUPS = [
  { label: null, pages: ["start", "overview"] },
  { label: "资源", pages: ["workers", "proxy"] },
  { label: "设置", pages: ["client", "gateway", "models"] },
  { label: "运行", pages: ["usage", "diagnostics"] },
] as const;

export type PageId = (typeof NAV_GROUPS)[number]["pages"][number];

export const PAGES: readonly PageId[] = NAV_GROUPS.flatMap((g) => g.pages);

export const PAGE_LABEL: Record<PageId, string> = {
  start: "快速开始",
  overview: "概览",
  workers: "Worker",
  proxy: "出口",
  client: "客户端接入",
  gateway: "网关",
  models: "模型",
  usage: "用量",
  diagnostics: "诊断",
};

export type ViewState = {
  readonly page: PageId;
  /** 页内标签（如出口页的 `list` / `subscriptions` / `clash`）。 */
  readonly tab: string | null;
  /** 搜索词。 */
  readonly q: string;
  /** 详情侧栏打开的对象 id（如 Worker 详情），可分享、可后退。 */
  readonly detail: string | null;
  /** 页内视图切换（如用量图表的维度/图形），与 tab 分开：tab 是页内一级标签。 */
  readonly view: string | null;
  /** 状态筛选。 */
  readonly status: string | null;
  readonly sort: string | null;
  /** 1 起算。 */
  readonly page_: number;
};

const DEFAULTS: ViewState = {
  page: "overview",
  tab: null,
  q: "",
  detail: null,
  view: null,
  status: null,
  sort: null,
  page_: 1,
};

/**
 * 解析 hash。
 *
 * 形如 `#proxy?tab=clash&q=hk&page=2`。**未知页面回落到 overview** ——
 * 一个手打错的 URL 不该显示空白页；而回落到概览是用户能理解的结果。
 * 空 hash 同样解析为 overview；首启未完成时改去快速开始由 `App` 决定，
 * 因为那取决于运行数据，不是 URL 本身的含义。
 */
export function parseHash(hash: string): ViewState {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "") return DEFAULTS;

  const [pageRaw, queryRaw = ""] = raw.split("?");
  const params = new URLSearchParams(queryRaw);

  const page = (PAGES as readonly string[]).includes(pageRaw ?? "")
    ? (pageRaw as PageId)
    : DEFAULTS.page;

  /*
   * 页码必须容错:URL 是用户可编辑的,`page=abc` 或 `page=-3` 都可能出现。
   * 回落到 1 而不是报错 —— 那是个无害的输入,不值得一个错误页。
   */
  const pageNum = Number.parseInt(params.get("page") ?? "1", 10);

  return {
    page,
    tab: params.get("tab"),
    q: params.get("q") ?? "",
    detail: params.get("detail"),
    view: params.get("view"),
    status: params.get("status"),
    sort: params.get("sort"),
    page_: Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1,
  };
}

/**
 * 序列化成 hash。
 *
 * **只写非默认值** —— 否则 `#overview?tab=&q=&page=1` 这种噪音会出现在
 * 每一个链接里，而用户要复制分享的正是这个字符串。
 */
export function toHash(state: ViewState): string {
  const params = new URLSearchParams();
  if (state.tab !== null && state.tab !== "") params.set("tab", state.tab);
  if (state.q !== "") params.set("q", state.q);
  if (state.detail !== null && state.detail !== "") params.set("detail", state.detail);
  if (state.view !== null && state.view !== "") params.set("view", state.view);
  if (state.status !== null && state.status !== "") params.set("status", state.status);
  if (state.sort !== null && state.sort !== "") params.set("sort", state.sort);
  if (state.page_ > 1) params.set("page", String(state.page_));

  const query = params.toString();
  return `#${state.page}${query === "" ? "" : `?${query}`}`;
}

/**
 * 订阅 URL 状态。
 *
 * `navigate` 接受**部分**更新并合并 —— 但切换页面时清掉页内状态
 * （搜索词、页码、标签），因为那些是**上一页**的东西：带着
 * `q=hk&page=3` 跳到 Worker 页会显示一个空列表，而用户不知道是因为
 * 还挂着代理池的搜索词。
 */
export function useViewState(): {
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
} {
  const [view, setView] = useState<ViewState>(() =>
    parseHash(typeof window === "undefined" ? "" : window.location.hash),
  );

  useEffect(() => {
    const onChange = () => setView(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback(
    (patch: Partial<ViewState>) => {
      setView((current) => {
        // 换页时页内状态归零 —— 它们属于上一页。
        const base: ViewState =
          patch.page !== undefined && patch.page !== current.page
            ? { ...DEFAULTS, page: patch.page }
            : current;
        const next = { ...base, ...patch };
        /*
         * 写 hash 而不是 `setState` 之后再同步 —— 让 URL 成为**唯一**来源。
         * 两处各存一份会分叉（纪律 #4），而分叉的症状是「点了导航但 URL 没变」
         * 或反之，且刷新后跳到另一个页面。
         */
        window.location.hash = toHash(next);
        return next;
      });
    },
    [],
  );

  return { view, navigate };
}
