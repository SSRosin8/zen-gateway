import { poolHealth, type Overview, type PoolHealth, type WorkerView } from "../../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, Panel, PrimaryButton, SecondaryButton, Truncate } from "../components/Panel.tsx";
import { DataTable, type Column } from "../components/DataTable.tsx";
import { useProbe, type ProbeRun } from "../lib/api.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { humanMs } from "../lib/format.ts";

/**
 * Overview 页。
 *
 * ## 这一页要回答三个问题，其余都是噪音
 *
 * 1. 网关能用吗（服务活着、有可用 Worker、目录拉到了）
 * 2. 回显出口是否共用 —— 这是配置核对的重要信号，未知状态必须显眼
 * 3. 某个 Worker 为什么没在被用（停用？没 key？在冷却？）
 *
 * 2 与 3 在同一张 Worker 表里：回显出口是一列，共用与探测进度都标在对应行上。
 *
 * 配置知道「配了什么」，调度器知道「现在能不能用」；`/api/overview` 把两者
 * 合在一处，所以这一页的 Worker 表能同时显示 `enabled` / `inPool` / `ready`
 * 三个不同的事实。网关连接细节在网关页，这里只给一行摘要。
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

const POOL_ICON: Record<PoolHealth, string> = { empty: "○", healthy: "✓", degraded: "!" };

/**
 * 一个 Worker 现在的状态 —— **三个事实合成一句话**。
 *
 * 顺序即优先级，每一层的下一步都不同：
 *   停用 → 去启用它；没 key → 去填 key；冷却中 → 等，或看 lastFailure；就绪 → 无事
 *
 * 这个函数是「为什么没在用我这个账号」那个问题的答案所在，所以它不能
 * 把几种情况合成「不可用」—— 那样用户仍然不知道原因。
 *
 * 返回类型刻意**窄于 `StatusTone`**（不含 `info`）：`RowMark` 的左边框只为
 * 这四档定了颜色，而 Worker 状态里没有「信息」这一档。写宽了会让 tsc 放过
 * 一个 `RowMark` 接不住的值。
 */
export function workerStatus(w: WorkerView): {
  tone: "success" | "warn" | "error" | "neutral";
  icon: string;
  label: string;
} {
  if (!w.enabled) return { tone: "neutral", icon: "○", label: "已停用" };
  /*
   * 启用了但没 key —— 必须与「已停用」分开。
   *
   * `isUsable()` 对认证 Worker 要求 apiKey 非空，对匿名 Worker 允许免 key。
   * 这里按 kind 判断，避免把合法的匿名 Worker 误报成缺少凭证。
   */
  if (w.kind === "authenticated" && !w.apiKey.present) {
    return { tone: "error", icon: "✕", label: "缺少 API key" };
  }
  if (!w.inPool) return { tone: "error", icon: "✕", label: "不在候选池" };
  if (!w.ready) {
    const why = w.lastFailure === null ? "" : `（${w.lastFailure}）`;
    return {
      tone: "warn",
      icon: "◴",
      label: `冷却中 ${humanMs(w.cooldownRemainingMs)}${why}`,
    };
  }
  return { tone: "success", icon: "✓", label: "就绪" };
}

/** 在用出口的探测 id，与服务端 `usedProxyIds` 同一判据：候选池里的 Worker，直连记 `__direct__`。 */
export function probeTargets(workers: readonly WorkerView[]): string[] {
  return [...new Set(workers.filter((w) => w.inPool).map((w) => w.proxyId ?? DIRECT_EGRESS_ID))];
}

/**
 * 出口一列：已保存的回显 IP + 共用标记；本轮探测进行中时显示这一行的进度或失败原因。
 * 共用以服务端的 `sharedGroups` 为准，前端不自己按 IP 分组。
 */
function EgressCell({ w, shared, probe }: { w: WorkerView; shared: boolean; probe: ProbeRun }) {
  const id = w.proxyId ?? DIRECT_EGRESS_ID;
  const result = probe.results[id];
  if (probe.current === id) return <StatusIndicator tone="info" icon="◴" label="探测中…" />;
  if (result !== undefined && !result.ok) {
    return (
      <span className="inline-flex items-baseline gap-2">
        <StatusIndicator tone="error" icon="✕" label="探测失败" />
        <Truncate text={result.reason} maxWidth="16rem" className="text-label-13 text-text-muted" />
      </span>
    );
  }
  if (w.egressIp === null) {
    return <span className="text-text-muted">{w.proxyId === null ? "本机直连 · 未探测" : "未探测"}</span>;
  }
  return (
    <span className="inline-flex items-baseline gap-2">
      <Mono>{w.egressIp}</Mono>
      {w.proxyId === null && <span className="text-label-13 text-text-muted">本机直连</span>}
      {shared && <StatusIndicator tone="error" icon="✕" label="共用" />}
      {result?.ok === true && <span className="text-label-13 text-text-muted">{result.latencyMs}ms</span>}
    </span>
  );
}

function workerColumns(sharedIds: ReadonlySet<string>, probe: ProbeRun): ReadonlyArray<Column<WorkerView>> {
  return [
    {
      key: "id",
      header: "Worker",
      render: (w) => (
        <>
          <Mono>{w.id}</Mono>
          {w.name !== "" && <Truncate text={w.name} maxWidth="16rem" className="ml-2 text-text-muted" />}
        </>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (w) => {
        const status = workerStatus(w);
        return <StatusIndicator tone={status.tone} icon={status.icon} label={status.label} />;
      },
    },
    {
      key: "egress",
      header: "回显出口",
      render: (w) => <EgressCell w={w} shared={sharedIds.has(w.id)} probe={probe} />,
    },
    {
      key: "key",
      header: "API key",
      render: (w) =>
        w.kind === "anonymous" ? (
          <span className="text-text-muted">无需 key</span>
        ) : w.apiKey.present ? (
          /* 只给指纹 —— 凭证绝不出进程。指纹供人眼比对「是不是我刚填的那个」。 */
          <Mono>{w.apiKey.fingerprint}</Mono>
        ) : (
          <span className="text-error">未配置</span>
        ),
    },
  ];
}

/**
 * Worker 与回显出口合在一张分页表里：出口是 Worker 的一个属性，单列一份分组列表时
 * 每个出口占一行，几十个 Worker 就是几十行重复信息。表上方一行说清整体结论。
 */
function WorkerPanel({
  data,
  page,
  onPage,
  probe,
}: {
  data: Overview;
  page: number;
  onPage: (page: number) => void;
  probe: ProbeRun;
}) {
  const { groups, sharedGroups, unknownWorkerIds, isolated } = data.isolation;
  const sharedIds = new Set(sharedGroups.flatMap((g) => g.workerIds));
  const targets = probeTargets(data.workers);

  const status = isolated
    ? { tone: "success" as StatusTone, icon: "✓", label: `回显出口独立 · ${groups.length} 个出口` }
    : sharedGroups.length > 0
      ? { tone: "error" as StatusTone, icon: "✕", label: `回显出口共用 · ${sharedGroups.length} 组共用出口` }
      : { tone: "warn" as StatusTone, icon: "!", label: `${unknownWorkerIds.length} 个出口未探测` };

  return (
    <Panel
      title={`Worker（${data.workers.length}）`}
      /* 标题数全部 Worker（表里每一行）；「就绪」指标只数候选池，两者差额在指标说明里写明。 */
      action={
        <span className="flex flex-wrap items-center gap-2">
          {probe.running && <SecondaryButton onClick={probe.stop}>停止</SecondaryButton>}
          <PrimaryButton onClick={() => void probe.run(targets)} disabled={probe.running || targets.length === 0}>
            {probe.running ? `探测中 ${probe.done}/${probe.total ?? 0}` : "探测出口"}
          </PrimaryButton>
        </span>
      }
    >
      {data.workers.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <StatusIndicator tone={status.tone} icon={status.icon} label={status.label} />
          <span className="text-text-muted">
            仅反映 IP 回显目标的出口，Zen 实际出口需核对发往 opencode.ai 的连接；已保存的 IP
            是最后一次成功探测结果，不代表当前仍然可用。
          </span>
        </div>
      )}
      <div aria-live="polite">
        {probe.error !== null && (
          <p role="alert" className="mb-3">
            <StatusIndicator tone="error" icon="✕" label={`探测失败：${probe.error}`} />
          </p>
        )}
        {!probe.running && probe.total !== null && probe.error === null && (
          <p className="mb-3 text-text-muted">
            本轮探测了 {probe.done}/{probe.total} 个出口，
            {Object.values(probe.results).filter((r) => !r.ok).length} 个失败。
          </p>
        )}
      </div>
      <DataTable
        label="Worker 状态"
        rows={data.workers}
        columns={workerColumns(sharedIds, probe)}
        rowKey={(w) => w.id}
        /* 行状态用 3px 左边框实色 —— 背景色块在 25% alpha 下只有 1.41 对比度（见 RowMark）。 */
        rowTone={(w) => workerStatus(w).tone}
        page={page}
        onPageChange={onPage}
        empty={
          <>
            <p className="text-heading-16 font-medium">还没有配置 Worker</p>
            <p className="mt-1 text-text-muted">
              在 <a href="#workers" className="text-accent-fg underline">Worker 页</a>{" "}
              新增一个：匿名 Worker 不需要 key，认证 Worker 填你自己的 Zen API key。
            </p>
          </>
        }
      />
    </Panel>
  );
}

export function OverviewPage({
  data,
  page = 1,
  onPage = () => {},
  probe,
}: {
  data: Overview;
  /** Worker 表页码，来自 URL。 */
  page?: number;
  onPage?: (page: number) => void;
  /** 出口探测的状态归 App（离开本页不中断），见 `useProbe`。不传时本页自己持有（测试用）。 */
  probe?: ProbeRun;
}) {
  const local = useProbe();
  const run = probe ?? local;
  const targets = probeTargets(data.workers);
  // 一个出口可能被多个 Worker 共用；只要其中一个有 IP，这个出口就已探测过。
  const probed = new Set(data.workers.filter((w) => w.inPool && w.egressIp !== null).map((w) => w.proxyId ?? DIRECT_EGRESS_ID));
  const unprobed = targets.filter((t) => !probed.has(t)).length;
  const pool = poolHealth(data.pool);

  /*
   * 目录状态。`freeCount` 为 **null 表示还没拿到目录**（不是 0 个免费模型）——
   * 两者的下一步完全不同：前者查网络/CA，后者查 freeSuffix。
   */
  const catalogTone: "success" | "warn" | "error" =
    data.catalog.freeCount === null ? "error" : data.catalog.freeCount === 0 ? "warn" : "success";
  const catalogLabel =
    data.catalog.freeCount === null
      ? "目录未拉到"
      : data.catalog.freeCount === 0
        ? "目录可达但免费集为空"
        : `${data.catalog.freeCount} 个免费模型`;

  return (
    <div className="space-y-4">
      <Panel title="概览">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {/* 分母是候选池里的 Worker；停用或缺 key 的不在池里，另行写在说明里，免得同页出现两个总数。 */}
          <Metric
            label="就绪 Worker"
            value={`${data.pool.ready}/${data.pool.total}`}
            hint={
              data.workers.length > data.pool.total
                ? `${POOL_LABEL[pool]} · 另有 ${data.workers.length - data.pool.total} 个不在候选池`
                : POOL_LABEL[pool]
            }
            tone={pool === "healthy" ? "normal" : pool === "degraded" ? "warn" : "normal"}
          />
          <Metric
            label="免费模型"
            value={data.catalog.freeCount === null ? "—" : String(data.catalog.freeCount)}
            hint={data.catalog.freeCount === null ? "目录未拉到" : "在架且免费"}
            tone={data.catalog.freeCount === null ? "error" : "normal"}
          />
          {/* 与 Worker 同一口径：在用出口里已有回显 IP 的有几个；代理池总数在代理池页。 */}
          <Metric
            label="已探测出口"
            value={`${targets.length - unprobed}/${targets.length}`}
            hint={unprobed === 0 ? "在用出口都有回显 IP" : `${unprobed} 个在用出口未探测`}
            tone={unprobed === 0 ? "normal" : "warn"}
          />
          <Metric
            label="运行时长"
            value={humanMs(data.health.uptimeSeconds * 1000)}
            hint={`v${data.health.version} · pid ${data.health.pid}`}
          />
        </div>

        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4">
          <StatusIndicator tone={POOL_TONE[pool]} icon={POOL_ICON[pool]} label={POOL_LABEL[pool]} />
          <StatusIndicator tone={catalogTone} icon={catalogTone === "success" ? "✓" : "!"} label={catalogLabel} />
          {/*
            统计写失败非 0 必须显眼:一个一直写失败的库会安静地给出全 0 报表,
            而那看起来像「没人用」。0 是正常值,所以只在非 0 时显示。
          */}
          {data.health.storeWriteFailures > 0 && (
            <StatusIndicator
              tone="warn"
              icon="!"
              label={`统计写失败 ${data.health.storeWriteFailures} 次（报表不可信）`}
            />
          )}
        </div>
      </Panel>

      <WorkerPanel data={data} page={page} onPage={onPage} probe={run} />

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-text-muted" data-gateway-summary="">
        <span>
          监听 <Mono>127.0.0.1:{data.gateway.port}</Mono>
        </span>
        <span>最多尝试 {data.gateway.maxAttempts} 个 Worker</span>
        <span>Clash 桥接{data.clash.enabled ? "已启用" : "未启用"}</span>
        <a href="#gateway" className="text-accent-fg underline">
          网关页查看连接与客户端配置
        </a>
      </p>
    </div>
  );
}
