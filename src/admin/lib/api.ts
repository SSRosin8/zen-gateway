import { useCallback, useEffect, useState } from "react";
import { OverviewSchema, type Overview } from "../../shared/contract.ts";

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
