import { poolHealth, type OpenCodeView, type Overview, type PoolHealth, type StatsView } from "../../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, PageHeader, Panel, SecondaryLink } from "../components/Panel.tsx";
import type { FetchState } from "../lib/api.ts";
import { humanMs } from "../lib/format.ts";
import { probeTargets } from "../lib/workerView.tsx";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";

export { workerStatus, probeTargets } from "../lib/workerView.tsx";

/**
 * 概览 —— 分诊台，只回答「有没有要我处理的事」。
 *
 * 顶部四个指标说整体状况，下面是「需要处理」清单：每条是一个事实 + 一个去处理的按钮。
 * 清单为空时显示一切正常。Worker 列表、出口探测与共用标记都在 Worker 页，概览不再重复一张表。
 *
 * 判据全部来自服务端（overview、`/api/opencode`、近 1 天统计），前端不自己推断。
 */

const POOL_LABEL: Record<PoolHealth, string> = {
  empty: "尚未配置 Worker",
  healthy: "全部就绪",
  degraded: "部分就绪",
};

export type AttentionItem = {
  readonly id: string;
  readonly tone: Extract<StatusTone, "error" | "warn" | "info">;
  readonly text: string;
  readonly action: { readonly label: string; readonly href: string };
};

/** 需要处理的事项，按严重度排（error → warn → info）。导出供测试。 */
export function attentionItems(
  data: Overview,
  opencode: FetchState<OpenCodeView>,
  recent: StatsView | null,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  const { sharedGroups, unknownWorkerIds } = data.isolation;

  if (data.catalog.freeCount === null) {
    out.push({ id: "catalog", tone: "error", text: "还没拉到上游模型目录，客户端看不到模型", action: { label: "诊断", href: "#diagnostics" } });
  } else if (data.catalog.freeCount === 0) {
    out.push({ id: "catalog-empty", tone: "warn", text: "目录可达但免费模型为空", action: { label: "检查免费规则", href: "#models" } });
  }
  if (data.workers.length === 0) {
    out.push({ id: "no-worker", tone: "error", text: "还没有 Worker，客户端请求会得到 503", action: { label: "新建 Worker", href: "#workers" } });
  } else if (data.pool.total === 0) {
    out.push({ id: "no-pool", tone: "error", text: "没有一个 Worker 在候选池里（停用或缺 key）", action: { label: "查看 Worker", href: "#workers?status=unusable" } });
  }
  if (sharedGroups.length > 0) {
    const ids = sharedGroups.flatMap((g) => g.workerIds);
    out.push({
      id: "shared",
      tone: "error",
      text: `${sharedGroups.length} 组 Worker 共用回显出口（${ids.join("、")}）`,
      action: { label: "查看共用的 Worker", href: "#workers?status=shared" },
    });
  }
  const noKey = data.workers.filter((w) => w.enabled && w.kind === "authenticated" && !w.apiKey.present);
  if (noKey.length > 0) {
    out.push({ id: "no-key", tone: "error", text: `${noKey.length} 个认证 Worker 缺少 API key`, action: { label: "去填写", href: "#workers?status=unusable" } });
  }
  if (opencode.status === "ready" && opencode.data.exists && !opencode.data.pointsToGateway) {
    out.push({ id: "opencode", tone: "warn", text: "项目 opencode.json 没有指向本网关（多半是 Relay Token 轮换后没重写）", action: { label: "重写", href: "#client" } });
  }
  const cooling = data.workers.filter((w) => w.inPool && !w.ready);
  if (cooling.length > 0) {
    out.push({ id: "cooling", tone: "warn", text: `${cooling.length} 个 Worker 在冷却中`, action: { label: "查看", href: "#workers?status=cooling" } });
  }
  if (data.health.storeWriteFailures > 0) {
    out.push({ id: "store", tone: "warn", text: `统计写失败 ${data.health.storeWriteFailures} 次，用量报表不可信`, action: { label: "诊断", href: "#diagnostics" } });
  }
  const rejected = recent === null ? 0 : Object.values(recent.rejections).reduce((a, b) => a + b, 0);
  if (rejected > 0) {
    out.push({ id: "rejected", tone: "info", text: `今天（UTC 日）有 ${rejected} 次请求被网关拒绝`, action: { label: "看是哪些模型", href: "#usage" } });
  }
  if (unknownWorkerIds.length > 0 && data.workers.length > 0) {
    out.push({ id: "unprobed", tone: "info", text: `${unknownWorkerIds.length} 个 Worker 的出口还没探测，无法判断是否独立`, action: { label: "去探测", href: "#workers" } });
  }

  const rank = { error: 0, warn: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

const ICON = { error: "✕", warn: "!", info: "○" } as const;

export function OverviewPage({
  data,
  opencode = { status: "loading" },
  recent = null,
}: {
  data: Overview;
  opencode?: FetchState<OpenCodeView>;
  /** 近 1 天的统计，只用来数网关拒绝；拿不到时不显示那一条。 */
  recent?: StatsView | null;
}) {
  const pool = poolHealth(data.pool);
  const items = attentionItems(data, opencode, recent);
  const targets = probeTargets(data.workers);
  // 一个出口可能被多个 Worker 共用；只要其中一个有 IP，这个出口就已探测过。
  const probed = new Set(data.workers.filter((w) => w.inPool && w.egressIp !== null).map((w) => w.proxyId ?? DIRECT_EGRESS_ID));
  const unprobed = targets.filter((t) => !probed.has(t)).length;

  return (
    <div className="space-y-4">
      <PageHeader title="概览" status={`v${data.health.version} · 已运行 ${humanMs(data.health.uptimeSeconds * 1000)}`} />

      <Panel title="状态">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {/* 分母是候选池里的 Worker；停用或缺 key 的不在池里，写在说明里，免得同页出现两个总数。 */}
          <Metric
            label="就绪 Worker"
            value={`${data.pool.ready}/${data.pool.total}`}
            hint={
              data.workers.length > data.pool.total
                ? `${POOL_LABEL[pool]} · 另有 ${data.workers.length - data.pool.total} 个不在候选池`
                : POOL_LABEL[pool]
            }
            tone={pool === "degraded" ? "warn" : "normal"}
          />
          <Metric
            label="免费模型"
            value={data.catalog.freeCount === null ? "—" : String(data.catalog.freeCount)}
            hint={data.catalog.freeCount === null ? "目录未拉到" : "在架且免费"}
            tone={data.catalog.freeCount === null ? "error" : "normal"}
          />
          {/* 与 Worker 同一口径：在用出口里已有回显 IP 的有几个；出口池总数在出口页。 */}
          <Metric
            label="已探测出口"
            value={`${targets.length - unprobed}/${targets.length}`}
            hint={unprobed === 0 ? "在用出口都有回显 IP" : `${unprobed} 个在用出口未探测`}
            tone={unprobed === 0 ? "normal" : "warn"}
          />
          <Metric
            label="共用出口"
            value={String(data.isolation.sharedGroups.length)}
            hint={data.isolation.isolated ? "回显出口互不相同" : "组"}
            tone={data.isolation.sharedGroups.length > 0 ? "error" : "normal"}
          />
        </div>
      </Panel>

      <Panel title={items.length === 0 ? "需要处理" : `需要处理（${items.length}）`}>
        {items.length === 0 ? (
          <StatusIndicator tone="success" icon="✓" label="一切正常，没有需要处理的事" />
        ) : (
          <ul className="divide-y divide-border" aria-label="需要处理的事项">
            {items.map((item) => (
              <li key={item.id} className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 py-2" data-attention={item.id}>
                <StatusIndicator tone={item.tone} icon={ICON[item.tone]} label={item.text} />
                <span className="ml-auto">
                  <SecondaryLink href={item.action.href}>{item.action.label}</SecondaryLink>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-text-muted" data-gateway-summary="">
        <span>
          监听 <Mono>127.0.0.1:{data.gateway.port}</Mono>
        </span>
        <span>最多尝试 {data.gateway.maxAttempts} 个 Worker</span>
        <span>Clash 桥接{data.clash.enabled ? "已启用" : "未启用"}</span>
        <a href="#gateway" className="text-accent-fg underline">
          网关设置
        </a>
        <a href="#client" className="text-accent-fg underline">
          客户端接入
        </a>
      </p>
    </div>
  );
}
