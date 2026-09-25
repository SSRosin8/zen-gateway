/**
 * 批量探测的状态机 —— **纯 reducer**。
 *
 * 规划把它单列一节，理由是它不是一个「点了等结果」的按钮，而是本后台
 * **唯一**的长任务，而旧后台里交互最复杂的部分正是它。
 *
 * ## 为什么是纯函数
 *
 * 状态机的边界条件里有好几条是「错了不报错、只是行为怪」的类型
 * （取消后又收到旧响应、暂停期间进度继续涨、两段进度合成一个假百分比）。
 * 纯 reducer 让每条转移都能用一行断言钉住，不必起 HTTP 也不必等真实探测。
 * 这与 `routing/` 四块同一个理由。
 *
 * ## 两段进度不合成一个百分比
 *
 * 先筛选（快速可达性）再主探测，**两段各自的进度分开显示**。
 * 合成一个总百分比要给两段定权重，而那个权重是编的 —— 筛选比主探测快得多，
 * 于是进度条会先飞到 40% 再慢慢爬，用户会以为卡住了。
 * 两个数字各自诚实，比一个虚构的总数有用。
 *
 * ## `cancelling` 必须是独立中间态
 *
 * 取消是「请求已发出、等服务端确认」，不是立刻回 `idle`。直接回 idle 的话
 * 按钮立刻变成「开始」，而后台那一批探测还在跑（它们要切 selector）——
 * 用户此时再点开始就会有两批并发，而 selector 是进程外的全局状态。
 */

/** 状态字母表。**与 `batch_probe_jobs.state` 的 CHECK 同源** —— 那张表在 Phase 1 就按这个清单建好了。 */
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
  | { type: "probed"; addedWorkerId?: string }
  | { type: "pause" }
  | { type: "resume" }
  /** 用户请求取消 —— 进 `cancelling`，等服务端确认。 */
  | { type: "cancel" }
  /** 服务端确认整批结束（正常完成或取消生效）。 */
  | { type: "finished"; failureKind?: string };

/**
 * 转移函数。
 *
 * **不合法的转移返回原状态**，不抛异常：事件来自轮询与用户点击两个源，
 * 而它们可以乱序到达（用户在 `done` 之后又点了一次暂停、旧的一条 `probed`
 * 在 `finished` 之后才到）。抛异常会让一次无害的竞态变成一个错误页。
 */
export function reduce(current: BatchProgress, event: BatchEvent): BatchProgress {
  switch (event.type) {
    case "start":
      /*
       * 只能从 `idle` 或 `done` 开始。
       *
       * 运行中再点开始必须**无效** —— 两批并发会互相切 selector，
       * 而那是进程外的全局状态：两条链路会换掉对方的出口节点，
       * 于是实测到的 IP 不是转发实际会用的那个。
       */
      if (current.state !== "idle" && current.state !== "done") return current;
      return {
        ...INITIAL,
        state: "screening",
        screenTotal: Math.max(0, event.screenTotal),
      };

    case "screened":
      if (current.state !== "screening") return current;
      // 不越过总数 —— 一个「11/10」会让用户以为数字是乱的。
      return { ...current, screenDone: Math.min(current.screenDone + 1, current.screenTotal) };

    case "screenDone":
      if (current.state !== "screening") return current;
      return {
        ...current,
        state: "running",
        // 筛选段显示为完成 —— 它确实结束了，哪怕有些节点没通过。
        screenDone: current.screenTotal,
        mainTotal: Math.max(0, event.mainTotal),
      };

    case "probed": {
      /*
       * `paused` 时**不推进** —— 那是暂停的全部含义。
       *
       * 这条不是防御性冗余:暂停是前端状态,而在途的探测请求仍会回来
       * (一次桥接探测可能几秒)。若照收,暂停期间进度条继续涨,
       * 用户会以为暂停没生效。
       */
      if (current.state !== "running") return current;
      const added =
        event.addedWorkerId === undefined
          ? current.addedWorkerIds
          : [...current.addedWorkerIds, event.addedWorkerId];
      return {
        ...current,
        mainDone: Math.min(current.mainDone + 1, current.mainTotal),
        addedWorkerIds: added,
      };
    }

    case "pause":
      // 只有主探测段能暂停:筛选很快,暂停它没有意义且会让状态图多两条边。
      if (current.state !== "running") return current;
      return { ...current, state: "paused" };

    case "resume":
      if (current.state !== "paused") return current;
      return { ...current, state: "running" };

    case "cancel":
      /*
       * 已经结束或已在取消中就不动 —— 重复点取消不该产生第二次请求。
       * `idle` 也不动:没有东西可取消。
       */
      if (current.state === "idle" || current.state === "done" || current.state === "cancelling") {
        return current;
      }
      return { ...current, state: "cancelling", cancelRequested: true };

    case "finished":
      /*
       * 从任何**进行中**的状态都能结束（含 `cancelling`）。
       * 已经 `done` 时保持不变 —— 重复的结束通知是轮询的常态。
       */
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

/**
 * 两段各自的百分比。**刻意不给一个合成的总百分比** —— 见文件头。
 *
 * 分母为 0 时返回 null 而不是 0 或 100:「还没开始」与「0% 完成」是两件事,
 * 而 UI 要显示「—」而不是一根空进度条。
 */
export function percentages(p: BatchProgress): {
  screen: number | null;
  main: number | null;
} {
  return {
    screen: p.screenTotal === 0 ? null : Math.round((p.screenDone / p.screenTotal) * 100),
    main: p.mainTotal === 0 ? null : Math.round((p.mainDone / p.mainTotal) * 100),
  };
}

/**
 * 轮询间隔。运行中 500ms，其余 5000ms（规划明确的两个值）。
 *
 * `document.hidden` 的降频由调用方处理 —— 那依赖 DOM，而本模块是纯函数。
 */
export function pollIntervalMs(p: BatchProgress): number {
  return isActive(p) ? 500 : 5000;
}
