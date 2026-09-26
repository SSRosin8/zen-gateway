import { poolHealth, type Overview, type PoolHealth, type WorkerView } from "../../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, Panel, PrimaryButton, Strong } from "../components/Panel.tsx";
import { SimpleTable, type Column } from "../components/DataTable.tsx";
import { useProbe, type ProbeResult } from "../lib/api.ts";
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

const WORKER_COLUMNS: ReadonlyArray<Column<WorkerView>> = [
  {
    key: "id",
    header: "Worker",
    render: (w) => (
      <>
        <Mono>{w.id}</Mono>
        {w.name !== "" && <span className="ml-2 text-text-muted">{w.name}</span>}
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
    header: "出口 IP",
    render: (w) =>
      w.egressIp === null ? (
        <span className="text-text-muted">{w.proxyId === null ? "本机直连" : "未探测"}</span>
      ) : (
        <Mono>{w.egressIp}</Mono>
      ),
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

function WorkerTable({ workers }: { workers: readonly WorkerView[] }) {
  if (workers.length === 0) {
    return (
      <div className="rounded-md bg-surface-accent px-4 py-6 text-center">
        <p className="text-heading-16 font-medium">还没有配置 Worker</p>
        <p className="mt-1 text-text-muted">
          在 <a href="#workers" className="text-accent-fg underline">Worker 页</a>{" "}
          新增一个：匿名 Worker 不需要 key，认证 Worker 填你自己的 Zen API key。
        </p>
      </div>
    );
  }

  return (
    <SimpleTable
      label="Worker 状态"
      rows={workers}
      columns={WORKER_COLUMNS}
      rowKey={(w) => w.id}
      /* 行状态用 3px 左边框实色 —— 背景色块在 25% alpha 下只有 1.41 对比度（见 RowMark）。 */
      rowTone={(w) => workerStatus(w).tone}
      rowAttr="data-worker"
    />
  );
}

/**
 * 按回显目标的实测 IP 分组；它与 Zen 可能命中不同规则，不能推断上游出口。
 */
function IsolationPanel({
  isolation,
  probe,
}: {
  isolation: Overview["isolation"];
  probe: ReturnType<typeof useProbe>;
}) {
  const { groups, sharedGroups, unknownWorkerIds, isolated } = isolation;

  const status = isolated
    ? { tone: "success" as StatusTone, icon: "✓", label: `回显出口独立 · ${groups.length} 个出口` }
    : sharedGroups.length > 0
      ? {
          tone: "error" as StatusTone,
          icon: "✕",
          label: `回显出口共用 · ${sharedGroups.length} 组共用出口`,
        }
      : {
          tone: "warn" as StatusTone,
          icon: "!",
          label: `${unknownWorkerIds.length} 个出口未探测`,
        };

  return (
    <Panel
      title="回显出口"
      action={
        <PrimaryButton onClick={() => void probe.run()} disabled={probe.running}>
          {probe.running ? "探测中…" : "探测出口"}
        </PrimaryButton>
      }
    >
      <StatusIndicator tone={status.tone} icon={status.icon} label={status.label} />
      {sharedGroups.length > 0 && (
        <p className="mt-2 text-error">
          标记「共用」的 Worker 访问 IP 回显目标时使用<Strong>同一个</Strong>公网 IP。
        </p>
      )}
      <p className="mt-3 text-text-muted">
        仅反映 IP 回显目标的出口；Zen 实际出口需核对发往 opencode.ai 的连接。
        已保存的 IP 是最后一次成功探测结果，不代表当前仍然可用。
      </p>

      {groups.length > 0 && (
        <ul className="mt-3 space-y-1" aria-label="回显出口分组">
          {groups.map((g) => {
            const shared = g.workerIds.length > 1;
            return (
              <li key={g.egressIp}>
                <Mono>{g.egressIp}</Mono>
                <span className="text-text-muted"> ← {g.workerIds.join("、")}</span>
                {shared && (
                  <span className="ml-2">
                    <StatusIndicator tone="error" icon="✕" label="共用" />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {unknownWorkerIds.length > 0 && (
        <p className="mt-3 text-text-muted">
          未探测：{unknownWorkerIds.join("、")} —— 点「探测出口」实测公网 IP。
          尚不能判断这些回显出口是否独立。
        </p>
      )}

      <div aria-live="polite">
        {probe.error !== null && (
          <p role="alert" className="mt-3">
            <StatusIndicator tone="error" icon="✕" label={`探测失败：${probe.error}`} />
          </p>
        )}
      </div>
      {probe.results !== null && probe.error === null && (
        <ul className="mt-3 space-y-1 text-text-muted">
          {probe.results.map((r: ProbeResult) => (
            <li key={r.proxyId}>
              <Mono>{r.proxyId}</Mono>：
              {r.ok ? (
                <>
                  <Mono>{r.egressIp}</Mono> · {r.latencyMs}ms
                </>
              ) : (
                <span className="text-error">
                  {r.failureKind} —— {r.reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function OverviewPage({ data }: { data: Overview }) {
  const probe = useProbe();
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
          <Metric
            label="就绪 Worker"
            value={`${data.pool.ready}/${data.pool.total}`}
            hint={POOL_LABEL[pool]}
            tone={pool === "healthy" ? "normal" : pool === "degraded" ? "warn" : "normal"}
          />
          <Metric
            label="免费模型"
            value={data.catalog.freeCount === null ? "—" : String(data.catalog.freeCount)}
            hint={data.catalog.freeCount === null ? "目录未拉到" : "在架且免费"}
            tone={data.catalog.freeCount === null ? "error" : "normal"}
          />
          <Metric
            label="出口"
            value={`${data.proxies.withEgressIp}/${data.proxies.enabled}`}
            hint="已实测公网 IP"
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

      <IsolationPanel isolation={data.isolation} probe={probe} />

      <Panel title={`Worker（${data.workers.length}）`}>
        <WorkerTable workers={data.workers} />
      </Panel>

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
