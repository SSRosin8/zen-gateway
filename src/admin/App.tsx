import { useEffect, useState } from "react";
import { HealthSchema, poolHealth, type Health, type PoolHealth } from "../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "./components/StatusIndicator.tsx";

/**
 * Phase 0 的 App 只做一件事:证明 shared 契约、token 层、StatusIndicator
 * 三条链路在真实浏览器里都通。完整的 6 页导航在 Phase 9。
 */

const POOL_TONE: Record<PoolHealth, StatusTone> = {
  empty: "neutral",
  healthy: "success",
  degraded: "warn",
};

const POOL_LABEL: Record<PoolHealth, string> = {
  empty: "尚未配置 Worker",
  healthy: "全部就绪",
  degraded: "部分就绪",
};

const POOL_ICON: Record<PoolHealth, string> = {
  empty: "○",
  healthy: "✓",
  degraded: "!",
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/health", { signal: ctrl.signal })
      .then((r) => {
        // 不检查 ok 的话,一个带 JSON 体的 500 会被当成正常响应送去 parse。
        if (!r.ok) throw new Error(`健康检查返回 ${r.status}`);
        return r.json();
      })
      .then((raw) => setHealth(HealthSchema.parse(raw)))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
  }, []);

  // 全新安装时 Worker 数为 0 —— 此处刻意走空池路径,
  // 验证首启不会误报「全部健康」。
  const pool = poolHealth({ ready: 0, total: 0 });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">zen-gateway</h1>
        <p className="mt-1 text-text-muted">OpenCode Zen 免费模型本地网关</p>
      </header>

      <section className="rounded-lg border border-border-strong bg-surface p-5">
        <h2 className="mb-4 text-base font-medium">Worker 池</h2>
        <StatusIndicator tone={POOL_TONE[pool]} icon={POOL_ICON[pool]} label={POOL_LABEL[pool]} />
        <p className="mt-3 text-text-muted">
          还没有可用出口。运行 <code className="font-mono text-accent-fg">npm run setup</code> 自动配置。
        </p>
      </section>

      <section className="mt-4 rounded-lg border border-border-strong bg-surface p-5">
        <h2 className="mb-4 text-base font-medium">服务</h2>
        {health ? (
          <StatusIndicator tone="success" icon="✓" label={`运行中 · v${health.version}`} />
        ) : error ? (
          <StatusIndicator tone="error" icon="✕" label="未连接到网关服务" />
        ) : (
          <StatusIndicator tone="neutral" icon="○" label="检测中" />
        )}
      </section>
    </main>
  );
}
