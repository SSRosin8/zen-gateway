import { useCallback, useEffect, useRef, useState } from "react";
import {
  BatchProgressSchema,
  INITIAL_BATCH_VIEW,
  type BatchProgressView,
  OverviewSchema,
  SubscriptionRefreshSchema,
  type Overview,
  type ProbeResult,
  type SubscriptionRefresh,
} from "../../shared/contract.ts";
import type { ConfigPatch } from "../../shared/contract.ts";
import { pollIntervalMs } from "../../shared/batchProbe.ts";

/**
 * 管理 API 的客户端。
 *
 * ## 为什么每个响应都过一遍 schema
 *
 * 服务端已经校验过了，这里再来一次挡住的是**版本不一致**：`dist/admin` 与
 * `dist/server` 是两次独立构建，用户可能只重建了一个。那时字段缺失会在深处
 * 某个 `.map()` 上炸成 `Cannot read properties of undefined`，而在这里会得到
 * 一句「契约不匹配」—— 后者能自查。
 *
 * ## 为什么不用 react-query / swr
 *
 * 需要的是「轮询一个端点、过 schema、区分三种失败、保留上次数据」，
 * 下面的 `usePolledEndpoint` 就是全部。一个缓存库要带来它自己的一套生命周期
 * 概念，而这里没有缓存共享或失效的需求。
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
     * 一个解析函数就够。
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

/** 写入配置补丁；凭证只在请求体中单向发送，响应不回传配置内容。 */
export async function patchConfig(patch: ConfigPatch): Promise<void> {
  const res = await fetch("/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
}

/** 首次加载之后又失败了：保留上次数据，同时说明失败原因与数据时刻。 */
export type StaleInfo = {
  /** 上次成功拿到数据的时刻（`Date.now()`）。 */
  readonly lastSuccessAt: number;
  /** 最近一次失败：`offline` 为连接被拒，否则是错误说明。 */
  readonly failure: { kind: "offline" } | { kind: "error"; message: string };
};

export type Polled<T> = {
  state: FetchState<T>;
  refresh: () => void;
  /** 为 null 表示最近一次请求成功（或还没有成功过，此时看 `state`）。 */
  stale: StaleInfo | null;
};

type SafeParser<T> = {
  safeParse: (
    v: unknown,
  ) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } };
};

const contractMessage = (issue: string | undefined) =>
  `响应与契约不匹配（前后端版本可能不一致，试 npm run build）：${issue ?? "未知字段"}`;

/**
 * 轮询一个端点并过 schema。
 *
 * ## 三种失败分开报
 *
 * 契约不匹配（下一步 `npm run build`）与网关没在跑（下一步 `npm start`）
 * 必须分开。`fetch` 对「连接被拒」抛 TypeError，对 HTTP 错误**不抛** ——
 * 所以走到 catch 且是 TypeError 基本就是网关没在跑；其余是连上了但响应不对。
 *
 * ## 已有数据时失败不清空页面
 *
 * 首次成功之后，任何一次轮询失败都**保留上次数据**，只把失败记进 `stale`。
 * 否则网关重启的几秒里整页会退回「未连接」占位，页面卸载 —— 用户正在填的
 * 表单（包括刚输入的 API key）随之丢失。首次加载失败仍按三态显示。
 *
 * ## `document.hidden` 时不轮询
 *
 * 后台标签页里刷新一个没人看的页面只是浪费。
 */
function usePolledEndpoint<T>(path: string, schema: SafeParser<T>, intervalMs: number): Polled<T> {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [stale, setStale] = useState<StaleInfo | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** 上次成功的时刻。放 ref：失败分支要读最新值，而 effect 不因它重挂。 */
  const lastSuccessAt = useRef<number | null>(null);
  /** 当前数据属于哪个 path。path 变了（如用量页换时间窗）时旧数据不再代表新请求。 */
  const dataPath = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (dataPath.current !== path) {
      dataPath.current = null;
      lastSuccessAt.current = null;
      setState({ status: "loading" });
      setStale(null);
    }

    const fail = (failure: StaleInfo["failure"]) => {
      const since = lastSuccessAt.current;
      if (since !== null) {
        setStale({ lastSuccessAt: since, failure });
        return;
      }
      setState(failure.kind === "offline" ? { status: "offline" } : { status: "error", message: failure.message });
    };

    const load = async () => {
      try {
        const raw = await getJson(path);
        if (cancelled) return;
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          fail({ kind: "error", message: contractMessage(parsed.error.issues[0]?.message) });
          return;
        }
        lastSuccessAt.current = Date.now();
        dataPath.current = path;
        setState({ status: "ready", data: parsed.data });
        setStale(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof TypeError) fail({ kind: "offline" });
        else fail({ kind: "error", message: err instanceof Error ? err.message : String(err) });
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

  return { state, refresh, stale };
}

/**
 * 轮询 Overview。
 *
 * 间隔 3s：这一页的数字（冷却剩余、就绪数）以秒为单位变化，而它是个本机请求。
 */
export function useOverview(intervalMs = 3000): Polled<Overview> {
  return usePolledEndpoint("/api/overview", OverviewSchema, intervalMs);
}

/*
 * `ProbeResult` 从 `contract.ts` re-export，**不在这里手写第二份**：
 * 手写一份全 optional 的类型会让契约改字段时 admin 侧 typecheck 仍然通过，
 * 页面静默渲染 `undefined`。
 *
 * 契约那份是个 union（成功支有 `egressIp`/`latencyMs`/`via`，失败支有
 * `failureKind`/`reason`），比手写的"全部可选"精确：它让
 * `r.ok ? r.egressIp : r.reason` 这种分支访问被类型系统检查。
 */
export type { ProbeResult };

/**
 * 触发一次出口探测。
 *
 * **不是长任务**（那个状态机属于代理池页的批量探测）。但几秒的等待足够长到
 * 必须有「正在进行」的反馈 ——
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

/**
 * 通用的「拉一个端点并过 schema」—— 代理池、模型、用量页各自的数据。
 *
 * 与 `useOverview` 共用同一个实现，所以「契约不匹配与网关没在跑分开报」
 * 「已有数据时失败不清空」两条规则在每个端点上都成立。
 */
export function useEndpoint<T>(path: string, schema: SafeParser<T>, intervalMs = 5000): Polled<T> {
  return usePolledEndpoint(path, schema, intervalMs);
}

/**
 * 批量探测的轮询与控制。
 *
 * ## 轮询按 generation 编号防竞态
 *
 * 场景：用户点「取消」，而一个**取消之前**发出的
 * `GET /api/batch-probe` 正在途中。它带回来的是 `running` —— 若照收，
 * 界面会从「正在取消」跳回「探测中」，然后下一次轮询又跳回来。
 *
 * 每次**用户动作**都递增 generation，而轮询响应到达时若 generation 已变
 * 就丢弃。这不是防御性代码：一次桥接探测几秒，而轮询间隔 500ms，
 * 所以「动作与在途响应交错」是常态而不是边角。
 *
 * ## 间隔随状态变化 + `document.hidden` 降频
 *
 * 运行中 500ms / 空闲 5000ms（由 `pollIntervalMs` 给出）。后台标签页不轮询 ——
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
 * 后果是 200ms 内上万个请求，`document.hidden` 那条降频同样失效；单线程的
 * 本机网关每个请求都要跑一次 `batch.snapshot()`，打开代理池页就等于给自己压测。
 *
 * 所以 effect **只挂一次**，间隔从 ref 里读最新值。
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
 * 订阅
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
