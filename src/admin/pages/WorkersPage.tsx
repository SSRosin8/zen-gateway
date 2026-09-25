import type { Overview, WorkerView } from "../../shared/contract.ts";
import { Mono, Panel } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { DataTable, TableFilters, type Column } from "../components/DataTable.tsx";
import { workerStatus } from "./OverviewPage.tsx";
import type { ViewState } from "../lib/router.ts";

/**
 * Worker 页。
 *
 * 比 Overview 的那张表多两列（连续失败、绑定出口的可读形态）并且**可筛选**——
 * Overview 回答「整体怎么样」，这一页回答「这一个怎么了」。
 *
 * 状态判定复用 `workerStatus`（Overview 页导出的那个）而不是另写一份:
 * 两份必然分叉,而分叉后同一个 Worker 在两页显示不同状态 —— 用户会以为
 * 其中一页是旧数据。
 */
export function WorkersPage({
  data,
  view,
  navigate,
}: {
  data: Overview;
  view: ViewState;
  navigate: (patch: Partial<ViewState>) => void;
}) {
  const q = view.q.trim().toLowerCase();
  const filtered = data.workers.filter((w) => {
    if (q !== "") {
      const haystack = `${w.id} ${w.name} ${w.proxyId ?? ""} ${w.egressIp ?? ""}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (view.status === "ready" && !w.ready) return false;
    if (view.status === "cooling" && (w.ready || !w.inPool)) return false;
    if (view.status === "unusable" && w.inPool) return false;
    return true;
  });

  const columns: ReadonlyArray<Column<WorkerView>> = [
    {
      key: "id",
      header: "Worker",
      render: (w) => (
        <span>
          <Mono>{w.id}</Mono>
          {w.name !== "" && <span className="ml-2 text-text-muted">{w.name}</span>}
        </span>
      ),
    },
    {
      key: "status",
      header: "状态",
      render: (w) => {
        const s = workerStatus(w);
        return <StatusIndicator tone={s.tone} icon={s.icon} label={s.label} />;
      },
    },
    {
      key: "egress",
      header: "出口",
      render: (w) => (
        <span>
          {w.egressIp === null ? (
            <span className="text-text-muted">{w.proxyId === null ? "本机直连" : "未探测"}</span>
          ) : (
            <Mono>{w.egressIp}</Mono>
          )}
          {w.proxyId !== null && (
            <span className="block truncate text-text-muted" style={{ maxWidth: "16rem" }}>
              {w.proxyId}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "fails",
      header: "连续失败",
      numeric: true,
      /*
       * 这一列回答一个 Overview 答不了的问题:「连续失败 12 次却从未冷却」
       * 正是「客户端一直在发坏请求」这个结论的证据（`bad_request` 不冷却，
       * 但计数照加 —— 见 `markFailure` 的说明）。
       */
      render: (w) => (
        <span className={w.consecutiveFails > 0 ? "text-warn" : "text-text-muted"}>
          {w.consecutiveFails}
        </span>
      ),
    },
    {
      key: "key",
      header: "API key",
      render: (w) =>
        w.apiKey.present ? <Mono>{w.apiKey.fingerprint}</Mono> : <span className="text-error">未配置</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <Panel title={`Worker（${filtered.length}/${data.workers.length}）`}>
        <TableFilters
          q={view.q}
          onQ={(next) => navigate({ q: next, page_: 1 })}
          status={view.status}
          onStatus={(next) => navigate({ status: next, page_: 1 })}
          statuses={[
            { value: "ready", label: "就绪" },
            { value: "cooling", label: "冷却中" },
            { value: "unusable", label: "不可用" },
          ]}
          placeholder="搜索 id / 名称 / 出口 IP…"
        />
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(w) => w.id}
          rowTone={(w) => workerStatus(w).tone}
          page={view.page_}
          onPageChange={(next) => navigate({ page_: next })}
          empty={
            data.workers.length === 0 ? (
              <>
                <p className="font-serif text-lg">还没有配置 Worker</p>
                <p className="mt-1 text-text-muted">
                  转发需要至少一个带 Zen API key 的 Worker。每个 key 一条，
                  绑不同出口才有隔离意义。
                </p>
              </>
            ) : (
              <p className="text-text-muted">没有匹配的 Worker。</p>
            )
          }
        />
      </Panel>

      <Panel title="说明">
        <ul className="space-y-2 text-text-muted">
          <li>
            **「已启用」不等于「在候选池里」** —— 后者还要求 API key 非空。
            免 key 的匿名通道已被上游关闭（403 <Mono>FreeTierError</Mono>），
            所以没有 key 的 Worker 发出去必定失败，调度器直接过滤掉它。
          </li>
          <li>
            **冷却是分级的**：限流尊重上游的 <Mono>Retry-After</Mono>（默认 15 分钟）、
            鉴权失败固定 60 秒短退避、传输失败指数退避。
            <Mono>bad_request</Mono> **不冷却** —— 一次坏请求不该打掉所有健康 Worker。
          </li>
          <li>
            **冷却只延长不缩短**：并发失败乱序到达时，一次传输失败的 2 秒
            不能覆盖 429 的 15 分钟。
          </li>
        </ul>
      </Panel>
    </div>
  );
}
