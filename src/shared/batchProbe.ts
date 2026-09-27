/**
 * 批量探测的状态机，纯 reducer，便于逐条转移断言。
 *
 * 筛选与主探测两段进度分开显示：合成总百分比需要编造权重。
 * `cancelling` 是独立中间态：等服务端确认前回 `idle` 会允许两批并发切 selector。
 */

/** 状态字母表，`batch_probe_jobs.state` 的 CHECK 按这个清单建。 */
export const BATCH_STATES = [
  "idle",
  "screening",
  "running",
  "paused",
  "cancelling",
  "done",
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

export type BatchProgress = {
  readonly state: BatchState;
  /** 第一段：快速可达性筛选。 */
  readonly screenTotal: number;
  readonly screenDone: number;
  /** 第二段：主探测（实测公网 IP）。 */
  readonly mainTotal: number;
  readonly mainDone: number;
  /** 已请求取消，等服务端确认。 */
  readonly cancelRequested: boolean;
  /** 批测过程中新建的 Worker id —— 结束后可直接跳转查看。 */
  readonly addedWorkerIds: readonly string[];
  /** 非 null 表示整批失败（而不是某个节点失败）。 */
  readonly failureKind: string | null;
};

export const INITIAL: BatchProgress = {
  state: "idle",
  screenTotal: 0,
  screenDone: 0,
  mainTotal: 0,
  mainDone: 0,
  cancelRequested: false,
  addedWorkerIds: [],
  failureKind: null,
};

export type BatchEvent =
  /** 开始：进入筛选段。 */
  | { type: "start"; screenTotal: number }
  /** 筛选段推进一个。 */
  | { type: "screened" }
  /** 筛选完成，进入主探测段（`mainTotal` 是通过筛选的数量）。 */
  | { type: "screenDone"; mainTotal: number }
  /** 主探测推进一个。 */
  | { type: "probed" }
  /** 批测结束前为可用节点新建了一个 Worker（`createWorkers` 选项）。 */
  | { type: "workerAdded"; workerId: string }
  | { type: "pause" }
  | { type: "resume" }
  /** 用户请求取消 —— 进 `cancelling`，等服务端确认。 */
  | { type: "cancel" }
  /** 服务端确认整批结束（正常完成或取消生效）。 */
  | { type: "finished"; failureKind?: string };

/** 转移函数。不合法的转移返回原状态而不抛：轮询与点击两个事件源可以乱序到达。 */
export function reduce(current: BatchProgress, event: BatchEvent): BatchProgress {
  switch (event.type) {
    case "start":
      // 只能从 `idle` 或 `done` 开始：两批并发会互相切进程外的 selector，测到错的 IP。
      if (current.state !== "idle" && current.state !== "done") return current;
      return {
        ...INITIAL,
        state: "screening",
        screenTotal: Math.max(0, event.screenTotal),
      };

    case "screened":
      if (current.state !== "screening") return current;
      // 不越过总数。
      return { ...current, screenDone: Math.min(current.screenDone + 1, current.screenTotal) };

    case "screenDone":
      if (current.state !== "screening") return current;
      return {
        ...current,
        state: "running",
        screenDone: current.screenTotal,
        mainTotal: Math.max(0, event.mainTotal),
      };

    case "probed":
      // `paused` 时不推进：在途的探测结果仍会回来，照收会让暂停期间进度继续涨。
      if (current.state !== "running") return current;
      return { ...current, mainDone: Math.min(current.mainDone + 1, current.mainTotal) };

    case "workerAdded":
      // Worker 已经写进配置，是既成事实：暂停或取消中到达也要记下，否则界面不告诉用户新建了什么。
      if (current.state === "idle" || current.state === "done") return current;
      return { ...current, addedWorkerIds: [...current.addedWorkerIds, event.workerId] };

    case "pause":
      // 只有主探测段能暂停：筛选很快，暂停它没有意义。
      if (current.state !== "running") return current;
      return { ...current, state: "paused" };

    case "resume":
      if (current.state !== "paused") return current;
      return { ...current, state: "running" };

    case "cancel":
      // 重复点取消不产生第二次请求；`idle` 没有东西可取消。
      if (current.state === "idle" || current.state === "done" || current.state === "cancelling") {
        return current;
      }
      return { ...current, state: "cancelling", cancelRequested: true };

    case "finished":
      // 任何进行中的状态（含 `cancelling`）都能结束；重复的结束通知是轮询常态。
      if (current.state === "idle" || current.state === "done") return current;
      return {
        ...current,
        state: "done",
        ...(event.failureKind !== undefined ? { failureKind: event.failureKind } : {}),
      };
  }
}

/** 正在进行中（用于决定轮询频率与按钮禁用）。 */
export function isActive(p: BatchProgress): boolean {
  return p.state === "screening" || p.state === "running" || p.state === "cancelling";
}

/** 两段各自的百分比（不合成总数）。分母为 0 时返回 null，UI 显示「—」。 */
export function percentages(p: BatchProgress): {
  screen: number | null;
  main: number | null;
} {
  return {
    screen: p.screenTotal === 0 ? null : Math.round((p.screenDone / p.screenTotal) * 100),
    main: p.mainTotal === 0 ? null : Math.round((p.mainDone / p.mainTotal) * 100),
  };
}

/** 轮询间隔：运行中 500ms，其余 5000ms。`document.hidden` 降频由调用方处理。 */
export function pollIntervalMs(p: BatchProgress): number {
  return isActive(p) ? 500 : 5000;
}
