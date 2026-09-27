import { useEffect, useRef, useState } from "react";
import { StatusIndicator } from "./StatusIndicator.tsx";
import { Skeleton } from "./Panel.tsx";
import { TableSkeleton } from "./DataTable.tsx";
import type { FetchState, StaleInfo } from "../lib/api.ts";
import { humanMs } from "../lib/format.ts";

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
export function StaleBanner({ stale, hidden = false }: { stale: StaleInfo | null; hidden?: boolean }) {
  /*
   * 恢复后显示 3 秒「已重新连接」再消失：横幅静悄悄消失时，用户不确定是恢复了还是自己看漏了。
   */
  const [recovered, setRecovered] = useState(false);
  const wasStale = useRef(false);
  useEffect(() => {
    // 外层已显示同一次断连（概览的横幅）时这里不显示，也不把「被隐藏」当成「已恢复」：
    // 否则外层恢复的同时，这里会再报一次「已重新连接」，或在其实仍断着时误报。
    if (hidden) {
      wasStale.current = false;
      setRecovered(false);
      return;
    }
    if (stale !== null) {
      wasStale.current = true;
      setRecovered(false);
      return;
    }
    if (!wasStale.current) return;
    wasStale.current = false;
    setRecovered(true);
    const t = setTimeout(() => setRecovered(false), 3000);
    return () => clearTimeout(t);
  }, [stale, hidden]);
  if (hidden) return null;
  if (stale === null) {
    return recovered ? (
      <div role="status" className="mb-4 rounded-md border border-success bg-surface px-4 py-3">
        <StatusIndicator tone="success" icon="✓" label="已重新连接，数据已刷新" />
      </div>
    ) : null;
  }
  return <StaleBannerInner stale={stale} />;
}

function StaleBannerInner({ stale }: { stale: StaleInfo }) {
  const now = useNow();
  const age = humanMs(Math.max(0, now - stale.lastSuccessAt));
  return (
    <div role="status" className="mb-4 rounded-md border border-warn bg-surface-accent px-4 py-3">
      <StatusIndicator tone="warn" icon="!" label={`与网关的连接中断，显示的是 ${age}前的数据`} />
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

/**
 * 首次加载的非就绪态。
 *
 * | 态 | 含义 | 下一步 |
 * |---|---|---|
 * | `loading` | 首次请求在途 | 等 |
 * | `offline` | 连接被拒 —— 网关没在跑 | `npm start` |
 * | `error` | 连上了但响应不对 | 多半是前后端版本不一致 → `npm run build` |
 *
 * 合成一句「加载失败」会让用户去猜。这里**不替 Worker 池说话**：拿不到数据时
 * 不知道池的状态，显示「尚未配置」或「全部就绪」都是把未知当结论。
 */
export function FallbackView({ state }: { state: FetchState<unknown> }) {
  if (state.status === "loading") return <LoadingView />;
  return (
    <section className="rounded-lg border border-border-strong bg-surface p-5">
      <h2 className="mb-4 text-heading-16 font-medium">服务</h2>
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

/**
 * 首次加载：文字状态「检测中」立即显示（读屏只读它），骨架按最终布局占位 ——
 * 一个指标面板 + 一个表格面板，外框、内边距、行高与真实页面一致，数据到达时不跳。
 */
export function LoadingView() {
  return (
    <div className="space-y-4" data-loading="">
      <section className="rounded-lg border border-border-strong bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong px-4 py-3 sm:px-5">
          <h2 className="text-heading-16 font-medium">服务</h2>
          <StatusIndicator tone="neutral" icon="○" label="检测中" />
        </header>
        <div className="grid grid-cols-2 gap-6 px-4 py-4 sm:grid-cols-4 sm:px-5" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="mt-2 h-[30px] w-20" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-lg border border-border-strong bg-surface">
        <header className="border-b border-border-strong px-4 py-3 sm:px-5" aria-hidden="true">
          <Skeleton className="h-4 w-24" />
        </header>
        <div className="px-4 py-4 sm:px-5">
          <TableSkeleton columns={["30%", "25%", "25%", "20%"]} />
        </div>
      </section>
    </div>
  );
}
