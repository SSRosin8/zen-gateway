import { poolHealth, type Overview, type PoolHealth, type WorkerView } from "../../shared/contract.ts";
import { StatusIndicator, type StatusTone } from "../components/StatusIndicator.tsx";
import { Metric, Mono, Panel, PrimaryButton, RowMark } from "../components/Panel.tsx";
import { useProbe, type ProbeResult } from "../lib/api.ts";

/**
 * Overview 页。
 *
 * ## 这一页要回答三个问题，其余都是噪音
 *
 * 1. 网关能用吗（服务活着、有可用 Worker、目录拉到了）
 * 2. 出口隔离成立吗 —— 这是本项目**存在的理由**，不成立必须显眼
 * 3. 某个 Worker 为什么没在被用（停用？没 key？在冷却？）
 *
 * 第 3 条先前**无法回答**：配置知道「配了什么」，调度器知道「现在能不能用」，
 * 而进程外没有任何地方同时持有这两半（Phase 8 的 `doctor` 只能报配置形态，
 * 并在输出里明写了这个限制）。`/api/overview` 把两者合在一处，所以这一页
 * 的 Worker 表能同时显示 `enabled` / `inPool` / `ready` 三个不同的事实。
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

/** 冷却剩余的人可读形态。诊断输出里 `900000` 要读者自己换算是不友好的。 */
function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}秒`;
  return `${Math.round(ms / 60_000)}分钟`;
}

/**
 * 一个 Worker 现在的状态 —— **三个事实合成一句话**。
 *
 * 顺序即优先级，每一层的下一步都不同：
 *   停用 → 去启用它；没 key → 去填 key；冷却中 → 等，或看 lastFailure；就绪 → 无事
 *
 * 这个函数是「为什么没在用我这个账号」那个问题的答案所在，所以它不能
 * 把几种情况合成「不可用」—— 那正是先前 `doctor` 只能说「可用(配置形态)」
 * 而用户仍然不知道原因的状态。
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
   * `isUsable()` 除了 enabled 还要求 apiKey 非空(免 key 通道已被上游关闭,
   * 没有 key 的 Worker 发出去必定 403)。合成一类的话,用户会看到 enabled
   * 为真却发现它从不被选中,而界面上没有任何线索。
   */
  if (!w.apiKey.present) return { tone: "error", icon: "✕", label: "缺少 API key" };
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

function WorkerTable({ workers }: { workers: readonly WorkerView[] }) {
  if (workers.length === 0) {
    return (
      <div className="rounded-md bg-surface-accent px-4 py-6 text-center">
        <p className="font-serif text-lg">还没有配置 Worker</p>
        <p className="mt-1 text-text-muted">
          转发需要至少一个带 Zen API key 的 Worker。运行{" "}
          <Mono>npm run setup</Mono> 自动配置出口，然后把 key 填进{" "}
          <Mono>data/config.json</Mono>。
        </p>
      </div>
    );
  }

  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-border-strong text-text-muted">
          <th className="py-2 font-medium">Worker</th>
          <th className="py-2 font-medium">状态</th>
          <th className="py-2 font-medium">出口 IP</th>
          <th className="py-2 font-medium">API key</th>
        </tr>
      </thead>
      <tbody>
        {workers.map((w) => {
          const status = workerStatus(w);
          return (
            /* 行高 44px = 宽松密度，同时满足触摸目标 ≥44px。 */
            <tr
              key={w.id}
              className="relative border-b border-border last:border-0"
              style={{ height: "44px" }}
              data-worker={w.id}
            >
              <td className="pl-3">
                {/* 行状态用 3px 左边框实色 —— 背景色块在 25% alpha 下只有 1.006 对比度。 */}
                <RowMark tone={status.tone} />
                <Mono>{w.id}</Mono>
                {w.name !== "" && <span className="ml-2 text-text-muted">{w.name}</span>}
              </td>
              <td>
                <StatusIndicator tone={status.tone} icon={status.icon} label={status.label} />
              </td>
              <td>
                {w.egressIp === null ? (
                  <span className="text-text-muted">未探测</span>
                ) : (
                  <Mono>{w.egressIp}</Mono>
                )}
              </td>
              <td>
                {w.apiKey.present ? (
                  /* 只给指纹 —— 凭证绝不出进程。指纹供人眼比对「是不是我刚填的那个」。 */
                  <Mono>{w.apiKey.fingerprint}</Mono>
                ) : (
                  <span className="text-error">未配置</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 出口隔离面板 —— 本项目存在的理由，所以它有自己的一块。
 *
 * **按实测 `egressIp` 分组，不按代理 id**：两个不同代理可能 NAT 到同一个
 * 公网 IP，那种情况下「已隔离」是假的。未探测出 IP 的**不算已隔离** ——
 * 「还不知道」与「确认不同」是两件事，混在一起会给出虚假的安全感。
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
    ? { tone: "success" as StatusTone, icon: "✓", label: `已隔离 · ${groups.length} 个独立出口` }
    : sharedGroups.length > 0
      ? {
          tone: "error" as StatusTone,
          icon: "✕",
          label: `未隔离 · ${sharedGroups.length} 组共用出口`,
        }
      : {
          tone: "warn" as StatusTone,
          icon: "!",
          label: `${unknownWorkerIds.length} 个出口未探测`,
        };

  return (
    <Panel
      title="出口隔离"
      action={
        <PrimaryButton onClick={() => void probe.run()} disabled={probe.running}>
          {probe.running ? "探测中…" : "探测出口"}
        </PrimaryButton>
      }
    >
      <StatusIndicator tone={status.tone} icon={status.icon} label={status.label} />

      {sharedGroups.length > 0 && (
        <div className="mt-3">
          <p className="text-error">
            以下 Worker 从**同一个**公网 IP 出去 —— 多账号同 IP 有被上游判定
            关联的风险：
          </p>
          <ul className="mt-2 space-y-1">
            {sharedGroups.map((g) => (
              <li key={g.egressIp}>
                <Mono>{g.egressIp}</Mono>
                <span className="text-text-muted">：{g.workerIds.join("、")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownWorkerIds.length > 0 && (
        <p className="mt-3 text-text-muted">
          未探测：{unknownWorkerIds.join("、")} —— 点「探测出口」实测公网 IP。
          「还不知道」不算作已隔离。
        </p>
      )}

      {groups.length > 0 && (
        <ul className="mt-3 space-y-1">
          {groups.map((g) => (
            <li key={g.egressIp}>
              <Mono>{g.egressIp}</Mono>
              <span className="text-text-muted">
                {" "}
                ← {g.workerIds.join("、")}
                {g.workerIds.length > 1 && " ⚠ 共用"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {probe.error !== null && <p className="mt-3 text-error">探测失败：{probe.error}</p>}
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
   * Phase 8 的 doctor 为此专门分了两层，这里沿用同一个判据。
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

      <Panel title="网关">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-text-muted">监听</dt>
          <dd>
            <Mono>127.0.0.1:{data.gateway.port}</Mono>
          </dd>
          <dt className="text-text-muted">上游</dt>
          <dd>
            <Mono>{data.gateway.baseUrl}</Mono>
          </dd>
          <dt className="text-text-muted">Relay Token</dt>
          <dd>
            {data.gateway.relayToken.present ? (
              <>
                <Mono>{data.gateway.relayToken.fingerprint}</Mono>
                <span className="ml-2 text-text-muted">
                  （只显示指纹；完整值在 <Mono>data/config.json</Mono>）
                </span>
              </>
            ) : (
              <span className="text-error">未配置</span>
            )}
          </dd>
          <dt className="text-text-muted">最多尝试</dt>
          <dd>{data.gateway.maxAttempts} 个 Worker</dd>
          <dt className="text-text-muted">Clash 桥接</dt>
          <dd>
            {data.clash.enabled ? (
              <>
                已启用 ·{" "}
                {data.clash.bridges.filter((b) => b.enabled).length}/{data.clash.bridges.length} 个内核
                {data.clash.activeBridgeId !== null && (
                  <span className="text-text-muted">
                    {" "}
                    · 当前 <Mono>{data.clash.activeBridgeId}</Mono>
                  </span>
                )}
              </>
            ) : (
              <span className="text-text-muted">未启用</span>
            )}
          </dd>
        </dl>
      </Panel>
    </div>
  );
}
