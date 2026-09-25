import { useCallback, useEffect, useRef, useState } from "react";
import {
  BatchProgressSchema,
  INITIAL_BATCH_VIEW,
  type BatchProgressView,
  OverviewSchema,
  SubscriptionRefreshSchema,
  type Overview,
  type SubscriptionRefresh,
} from "../../shared/contract.ts";
import { pollIntervalMs } from "../../shared/batchProbe.ts";

/**
 * 管理 API 的客户端。
 *
 * ## 为什么每个响应都过一遍 schema
 *
 * 服务端已经校验过了（`OverviewSchema.parse` 在 handler 里），这里再来一次
 * 看似冗余 —— 但它挡住的是**版本不一致**：`dist/admin` 与 `dist/server` 是
 * 两次独立构建，用户可能只重建了一个（`npm start` 串了 `npm run build`，
 * 但 `npm run dev` 只起前端）。那时字段缺失会在深处某个 `.map()` 上炸成
 * 一句 `Cannot read properties of undefined`，而在这里会得到一句
 * 「契约不匹配」——后者能自查。
 *
 * ## 为什么不用 react-query / swr
 *
 * 这一页只有两个请求（overview 轮询、probe 手动触发），而一个缓存库要带来
 * 它自己的一套生命周期概念。旧项目记在案的痛点之一就是「为了行数而拆」，
 * 这里是它的近亲：为了一个 30 行的需求引入一个框架。
 */

/** 请求失败的分类 —— 三种，下一步完全不同。 */
export type FetchState<T> =
  | { status: "loading" }
  /** 网关没在跑（连接被拒）。 */
  | { status: "offline" }
  /** 连上了但响应不对（契约不匹配、500）。 */
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    /*
     * 管理面的错误体形状与转发面一致（`{error:{type,message}}`），所以这里
     * 一个解析函数就够 —— 那正是当初让两者形状对齐的理由。
     */
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (typeof body.error?.message === "string") detail = body.error.message;
    } catch {
      /* 非 JSON 响应，用状态码 */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * 轮询 Overview。
 *
 * 间隔 3s：这一页的数字（冷却剩余、就绪数）以秒为单位变化，而它是个本机
 * 请求（实测 <5ms）。`document.hidden` 时停止 —— 后台标签页里刷新一个
 * 没人看的页面只是浪费，而规划的长任务节明确要求「`document.hidden` 时降频」，
 * 这里是它的最简形态。
 */
export function useOverview(intervalMs = 3000): {
  state: FetchState<Overview>;
  refresh: () => void;
} {
  const [state, setState] = useState<FetchState<Overview>>({ status: "loading" });
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const raw = await getJson("/api/overview");
        if (cancelled) return;
        const parsed = OverviewSchema.safeParse(raw);
        if (!parsed.success) {
          /*
           * 契约不匹配 —— 与「网关没在跑」必须分开报。
           *
           * 前者的下一步是 `npm run build`（前后端版本不一致），
           * 后者是 `npm start`。合成一句「加载失败」会让用户猜。
           */
          setState({
            status: "error",
            message: `响应与契约不匹配（前后端版本可能不一致，试 npm run build）：${parsed.error.issues[0]?.message ?? "未知字段"}`,
          });
          return;
        }
        setState({ status: "ready", data: parsed.data });
      } catch (err) {
        if (cancelled) return;
        /*
         * `fetch` 对「连接被拒」抛 TypeError，对 HTTP 错误**不抛** ——
         * 所以走到这里且是 TypeError 基本就是网关没在跑。
         * 其余（我们自己在 getJson 里抛的 Error）是连上了但响应不对。
         */
        if (err instanceof TypeError) setState({ status: "offline" });
        else setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    };

    void load();

    // 后台标签页不轮询 —— 刷新一个没人看的页面只是浪费。
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, tick]);

  return { state, refresh };
}

export type ProbeResult = {
  proxyId: string;
  ok: boolean;
  egressIp?: string;
  latencyMs?: number;
  failureKind?: string;
  reason?: string;
};

/**
 * 触发一次出口探测。
 *
 * **不是长任务**（那个状态机属于 ProxyPool 页）：本机代理数是个位数，
 * 实测三个节点约 6 秒。但 6 秒足够长到必须有「正在进行」的反馈 ——
 * 否则用户会以为按钮没反应而再点一次，而重复探测会互相切 selector。
 * 所以 `running` 期间按钮必须禁用。
 */
export function useProbe(): {
  running: boolean;
  results: ProbeResult[] | null;
  error: string | null;
  run: () => Promise<void>;
} {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/probe", { method: "POST" });
      const body = (await res.json()) as
        | { ok: true; results: ProbeResult[] }
        | { error: { message: string } };
      if (!res.ok || "error" in body) {
        setError("error" in body ? body.error.message : `HTTP ${res.status}`);
        return;
      }
      setResults(body.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  return { running, results, error, run };
}

/* ------------------------------------------------------------------ *
 * 批次 2 的端点
 * ------------------------------------------------------------------ */

/**
 * 通用的「拉一个端点并过 schema」。
 *
 * 与 `useOverview` 同一套三态（loading / offline / error），只是端点与 schema
 * 可变。抽出来是因为 4 个页面要做同一件事 —— 而复制 4 遍会让「契约不匹配
 * 与网关没在跑必须分开报」这条规则在其中某一份里被漏掉。
 */
export function useEndpoint<T>(
  path: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  intervalMs = 5000,
): { state: FetchState<T>; refresh: () => void } {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const raw = await getJson(path);
        if (cancelled) return;
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          setState({
            status: "error",
            message: `响应与契约不匹配（前后端版本可能不一致，试 npm run build）：${parsed.error.issues[0]?.message ?? "未知字段"}`,
          });
          return;
        }
        setState({ status: "ready", data: parsed.data });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof TypeError) setState({ status: "offline" });
        else setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    };

    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `schema` 是模块级常量，不入依赖 —— 否则每次渲染都会重建轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, intervalMs, tick]);

  return { state, refresh };
}

/**
 * 批量探测的轮询与控制。
 *
 * ## 轮询按 generation 编号防竞态
 *
 * 规划明确要求这一条。场景：用户点「取消」，而一个**取消之前**发出的
 * `GET /api/batch-probe` 正在途中。它带回来的是 `running` —— 若照收，
 * 界面会从「正在取消」跳回「探测中」，然后下一次轮询又跳回来。
 *
 * 每次**用户动作**都递增 generation，而轮询响应到达时若 generation 已变
 * 就丢弃。这不是防御性代码：一次桥接探测几秒，而轮询间隔 500ms，
 * 所以「动作与在途响应交错」是常态而不是边角。
 *
 * ## 间隔随状态变化 + `document.hidden` 降频
 *
 * 运行中 500ms / 空闲 5000ms（规划的两个值）。后台标签页不轮询 ——
 * 刷新一个没人看的页面只是浪费。
 *
 * ## 为什么间隔要走 ref，而 effect 的依赖必须是空数组
 *
 * 间隔取决于**当前状态**,而状态是这个 effect 自己写进去的。
 * 于是「把 `progress` 放进依赖数组」会变成一个自激循环:
 * 响应到达 → `setProgress` → effect 重挂 → 立刻 `tick()` → 响应到达 → …
 * 而排好的 `setTimeout` 在重挂时被 cleanup 清掉,**间隔永远等不到**。
 *
 * 关键在于 `safeParse` **每次都返回新对象**,所以即使进度没有任何变化,
 * `setProgress` 也拿到一个新身份,`[progress]` 也就次次都变。
 * 实测(第八轮审核):200ms 内发出 **27691 个**请求 —— 设计值是每 5000ms 一个,
 * 而且 `document.hidden` 那条降频同样失效(隐藏标签页 32760 个)。
 * 单线程的本机网关每个请求都要跑一次 `batch.snapshot()`,于是打开代理池页
 * 就等于给自己压测。
 *
 * 修法是让 effect **只挂一次**,间隔从 ref 里读最新值。
 * 同一文件里的 `useOverview`/`useEndpoint` 本来就是这么做的
 * （它们刻意把 `state` 留在依赖数组外），这里当初漏了。
 */
export function useBatchProbe(): {
  progress: BatchProgressView;
  error: string | null;
  send: (action: "start" | "pause" | "resume" | "cancel") => Promise<void>;
} {
  const [progress, setProgress] = useState<BatchProgressView>(INITIAL_BATCH_VIEW);
  const [error, setError] = useState<string | null>(null);
  /** 见文档:每次用户动作递增,在途的旧响应据此作废。 */
  const generation = useRef(0);
  /**
   * 当前进度的镜像,只给排间隔用。
   *
   * 不能读闭包里的 `progress`:effect 只挂一次,那个值会永远是初始值
   * （于是探测跑起来后仍按 5000ms 轮询,进度条一卡一卡地跳）。
   */
  const latest = useRef<BatchProgressView>(INITIAL_BATCH_VIEW);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const myGeneration = generation.current;
      try {
        const res = await fetch("/api/batch-probe");
        if (cancelled) return;
        if (res.ok) {
          const parsed = BatchProgressSchema.safeParse(await res.json());
          /*
           * generation 变了 = 这条响应描述的是一个已经过时的世界。丢掉它。
           * 否则「点了取消又跳回探测中」这种闪烁会反复出现。
           */
          if (parsed.success && generation.current === myGeneration) {
            latest.current = parsed.data;
            setProgress(parsed.data);
          }
        }
      } catch {
        /* 轮询失败静默 —— 页面上其他地方会报「未连接」 */
      } finally {
        if (!cancelled) {
          /*
           * 间隔由**当前**状态决定，所以每轮重新排 —— 不用固定 interval。
           * 状态从 ref 读:effect 只挂一次(见文档,放进依赖数组会自激成忙轮询)。
           */
          timer = setTimeout(
            () => void tick(),
            document.hidden ? 5000 : pollIntervalMs(latest.current),
          );
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);

  const send = useCallback(async (action: "start" | "pause" | "resume" | "cancel") => {
    // 动作发出即作废所有在途轮询 —— 见文档。
    generation.current += 1;
    setError(null);
    try {
      const res = await fetch("/api/batch-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: { message?: string } }).error.message ?? `HTTP ${res.status}`)
            : `HTTP ${res.status}`;
        setError(message);
        return;
      }
      const parsed = BatchProgressSchema.safeParse(body);
      // 动作的响应**总是**采纳：它就是这次动作的结果，generation 已经是最新的。
      if (parsed.success) {
        // ref 要一起更新 —— 否则点了「开始」之后轮询仍按空闲的 5000ms 排。
        latest.current = parsed.data;
        setProgress(parsed.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { progress, error, send };
}

/* ------------------------------------------------------------------ *
 * 订阅（Phase 10）
 * ------------------------------------------------------------------ */

export type RefreshState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: SubscriptionRefresh }
  | { status: "error"; message: string };

/**
 * 刷新订阅。
 *
 * ## 按 id 记状态，不是一个全局 running
 *
 * 界面上每个订阅行各有一个"刷新"按钮。用一个全局 `running` 的话，点一个
 * 会让**所有**按钮都转圈 —— 用户分不清是哪个在跑，而服务端的互斥也是按 id 的
 * （两个不同订阅并发刷新是安全的，它们只动自己的节点）。
 *
 * ## 不轮询
 *
 * 刷新是一次请求一个答案，与批量探测不同（那个是长任务、进度归服务端）。
 * 多 UA 协商最坏 40 秒，所以按钮要一直禁用到响应回来 —— 否则用户
 * 会重复点，而服务端会回 409，看起来像是出错了。
 */
export function useSubscriptionRefresh(): {
  stateOf: (id: string) => RefreshState;
  refresh: (id: string) => Promise<void>;
} {
  const [states, setStates] = useState<Record<string, RefreshState>>({});

  const refresh = useCallback(async (id: string) => {
    setStates((prev) => ({ ...prev, [id]: { status: "running" } }));
    try {
      const res = await fetch(`/api/subscriptions/${encodeURIComponent(id)}/refresh`, {
        method: "POST",
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body
            ? String((body as { error: { message?: string } }).error.message ?? `HTTP ${res.status}`)
            : `HTTP ${res.status}`;
        setStates((prev) => ({ ...prev, [id]: { status: "error", message } }));
        return;
      }
      const parsed = SubscriptionRefreshSchema.safeParse(body);
      if (!parsed.success) {
        setStates((prev) => ({
          ...prev,
          [id]: { status: "error", message: "响应与契约不匹配（试 npm run build）" },
        }));
        return;
      }
      setStates((prev) => ({ ...prev, [id]: { status: "done", result: parsed.data } }));
    } catch (err) {
      setStates((prev) => ({
        ...prev,
        [id]: { status: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, []);

  const stateOf = useCallback(
    (id: string): RefreshState => states[id] ?? { status: "idle" },
    [states],
  );

  return { stateOf, refresh };
}
