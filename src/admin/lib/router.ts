/**
 * URL 是视图状态的**唯一来源**。
 *
 * 规划的交互要求：页面、标签、搜索词、状态筛选、排序、页码全部编码进 URL
 * （`/#proxy?tab=isolation&q=hk&status=ready&sort=latency&page=2`），
 * 刷新与分享都还原同一视图。
 *
 * > 这是**新增能力，不是继承**：旧项目没有深链接，页面状态存在内存里，刷新即丢。
 *
 * ## 为什么用 hash 而不是 History API
 *
 * 管理后台由 Vite dev server（或将来的静态产物）伺服，**没有服务端路由**。
 * 用 `pushState` 做 `/proxy` 这种路径的话，刷新会向服务器请求 `/proxy` ——
 * dev server 恰好会回 index.html（SPA fallback），而网关自己**不伺服静态产物**
 * （实测 `GET /` 返回 404）。于是同一份前端在两种部署下行为不同，
 * 而那种差异只在「用户刷新页面」时暴露。
 *
 * hash 不参与服务端路由，两种部署下都成立。代价是 URL 里多一个 `#`，
 * 对一个本机工具可以忽略。
 *
 * ## 为什么不用 react-router
 *
 * 需要的全部功能是「读写 hash + 订阅变化」，实现是下面这 60 行。
 * 一个路由库要带来它自己的一套概念（loader、嵌套路由、Outlet），
 * 而这里只有 6 个平级页面。旧项目记在案的痛点之一是「为了行数而拆」，
 * 引入框架解决一个 60 行的需求是它的近亲。
 */

import { useCallback, useEffect, useState } from "react";

/** 六个页面。**这份清单是唯一真相** —— 导航与路由分派都从它推导。 */
export const PAGES = ["overview", "gateway", "proxy", "workers", "models", "usage"] as const;
export type PageId = (typeof PAGES)[number];

export const PAGE_LABEL: Record<PageId, string> = {
  overview: "概览",
  gateway: "网关",
  proxy: "代理池",
  workers: "Worker",
  models: "模型",
  usage: "用量",
};

export type ViewState = {
  readonly page: PageId;
  /** 页内标签（如代理池的 `list` / `isolation`）。 */
  readonly tab: string | null;
  /** 搜索词。 */
  readonly q: string;
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
  status: null,
  sort: null,
  page_: 1,
};

/**
 * 解析 hash。
 *
 * 形如 `#proxy?tab=isolation&q=hk&page=2`。**未知页面回落到 overview** ——
 * 一个手打错的 URL 不该显示空白页；而回落到第一页是用户能理解的结果。
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
