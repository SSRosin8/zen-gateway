import { useState } from "react";
import { UNKNOWN_MODEL, type StatsView } from "../../shared/contract.ts";
import { FormStatus, Metric, Mono, PageHeader, Panel, SecondaryButton, Strong, type FormMessage } from "../components/Panel.tsx";
import { FilterChip, SEGMENTED_TRACK, SimpleTable, type Column } from "../components/DataTable.tsx";
import { HintTip } from "../components/HintTip.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { METRIC_LABEL, UsageChart, compact, type Metric as ChartMetric, type Shape } from "../components/UsageChart.tsx";
import { resetStats, useAction } from "../lib/consoleApi.ts";
import { FIELD } from "../lib/styles.ts";

/**
 * 用量页 —— 一张大图 + 同维度的明细表。
 *
 * 顶部四个数，下面一张按天的图：按模型 / 按 Worker 切换系列，面积 / 柱状（都堆叠）切换形状，
 * 指标可选 token、输入、输出、缓存读、请求数。图下的表跟着同一个维度，是图的数值版
 * （也是不能悬停时读数的途径）。时间范围、维度、形状、指标都在 URL 里。
 *
 * ## 三处「不估算」
 *
 * 1. 请求 ≠ 尝试：一条重试链是一个请求、多次尝试，两个数都显示。
 * 2. 上游没报的用量如实显示为缺失，不补均值。
 * 3. 「未完整解析」单独一栏：那是网关没读完响应，不是上游没报。
 */

function rate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** 网关拒绝原因的人话。取值与 `RejectionReason` 一一对应。 */
const REJECTION_LABEL: Record<string, string> = {
  not_free: "不是免费模型",
  retired: "已下架",
  body_unreadable: "请求体读不出来",
  body_too_large: "请求体超限",
  body_empty: "请求体为空",
  body_not_json: "请求体不是 JSON",
  model_missing: "缺 model 字段",
  stream_unsupported: "该面不支持流式",
  no_worker: "没有可用 Worker",
};

type ModelStat = StatsView["models"][number];
type WorkerStat = StatsView["workers"][number];
type RejectedModel = StatsView["rejectedModels"][number];

const REJECTION_COLUMNS: ReadonlyArray<Column<RejectedModel>> = [
  {
    key: "model",
    header: "请求的模型",
    render: (r) =>
      r.model === UNKNOWN_MODEL ? (
        <span className="text-text-muted">未提供或名称不合法</span>
      ) : (
        // 点进模型页看判定依据（为什么不是免费 / 已下架）。
        <a href={`#models?q=${encodeURIComponent(r.model)}`} className="text-accent-fg underline">
          <Mono>{r.model}</Mono>
        </a>
      ),
  },
  { key: "reason", header: "原因", render: (r) => REJECTION_LABEL[r.reason] ?? r.reason },
  { key: "count", header: "次数", numeric: true, render: (r) => r.count },
];

const MODEL_COLUMNS: ReadonlyArray<Column<ModelStat>> = [
  { key: "model", header: "模型", render: (m) => <Mono>{m.model}</Mono> },
  // 与 OpenCode 一致：输入含缓存命中，「其中缓存读」只是拆出来看，不另加进总数。
  { key: "in", header: "输入", numeric: true, render: (m) => compact(m.inputTokens) },
  { key: "cache", header: "其中缓存读", numeric: true, render: (m) => compact(m.cacheReadTokens) },
  { key: "out", header: "输出", numeric: true, render: (m) => compact(m.outputTokens) },
  { key: "total", header: "合计", numeric: true, render: (m) => compact(m.inputTokens + m.outputTokens) },
  { key: "with", header: "有用量", numeric: true, render: (m) => m.requestsWithUsage },
  // 「上游未报」与「未完整解析」分两列 —— 一个是上游的行为，一个是网关侧的限制。
  { key: "without", header: "未报", numeric: true, render: (m) => m.requestsWithoutUsage },
  {
    key: "dropped",
    header: "未完整解析",
    numeric: true,
    render: (m) => <span className={m.requestsDroppedUsage > 0 ? "text-warn" : ""}>{m.requestsDroppedUsage}</span>,
  },
];

type WorkerRow = WorkerStat & { input: number; output: number };

const WORKER_COLUMNS: ReadonlyArray<Column<WorkerRow>> = [
  {
    key: "id",
    header: "Worker",
    render: (w) => (
      <a href={`#workers?detail=${encodeURIComponent(w.workerId)}`} className="text-accent-fg underline">
        <Mono>{w.workerId}</Mono>
      </a>
    ),
  },
  { key: "in", header: "输入", numeric: true, render: (w) => compact(w.input) },
  { key: "out", header: "输出", numeric: true, render: (w) => compact(w.output) },
  { key: "attempts", header: "尝试", numeric: true, render: (w) => w.attempts },
  { key: "ok", header: "成功", numeric: true, render: (w) => w.successes },
  {
    key: "fail",
    header: "失败",
    numeric: true,
    render: (w) => <span className={w.failures > 0 ? "text-warn" : ""}>{w.failures}</span>,
  },
  {
    key: "status",
    header: "最近状态码",
    numeric: true,
    // null = 最近一次尝试是传输失败，没有 HTTP 状态码。
    render: (w) => (w.lastStatus === null ? <span className="text-text-muted">无响应</span> : <Mono>{w.lastStatus}</Mono>),
  },
];

export type UsageView = { by: "model" | "worker"; shape: Shape; metric: ChartMetric };

const METRICS: readonly ChartMetric[] = ["tokens", "input", "output", "cache", "requests"];

/** URL 里 `view` 的编码：`worker`、`bar`、指标名用 `:` 连接，默认值省略。 */
export function parseUsageView(raw: string | null): UsageView {
  const parts = (raw ?? "").split(":");
  return {
    by: parts.includes("worker") ? "worker" : "model",
    shape: parts.includes("bar") ? "bar" : "line",
    metric: METRICS.find((m) => parts.includes(m)) ?? "tokens",
  };
}

export function formatUsageView(v: UsageView): string | null {
  const parts = [v.by === "worker" ? "worker" : null, v.shape === "bar" ? "bar" : null, v.metric === "tokens" ? null : v.metric];
  const kept = parts.filter((x): x is string => x !== null);
  return kept.length === 0 ? null : kept.join(":");
}

/**
 * 可选的时间范围。URL 里的其他值一律当默认的 30 天：`days` 会原样进 `/api/stats` 的查询串。
 * 统计按 UTC 日分桶（`dayKey`），所以「今天」是 UTC 的今天，页头的起始日也标明 UTC。
 */
export const USAGE_RANGES = [
  { value: "1", label: "今天（UTC）" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "all", label: "全部" },
] as const;

export function UsagePage({
  data,
  days,
  onDays,
  view = { by: "model", shape: "line", metric: "tokens" },
  onView = () => {},
  onReset,
}: {
  data: StatsView;
  days: string;
  onDays: (days: string) => void;
  view?: UsageView;
  onView?: (view: UsageView) => void;
  /** 重置成功后调用（刷新统计）。 */
  onReset?: () => void;
}) {
  const totalRejections = Object.values(data.rejections).reduce((a, b) => a + b, 0);
  const [confirming, setConfirming] = useState(false);
  const reset = useAction(resetStats);
  const resetMessage: FormMessage =
    reset.state.status === "done"
      ? { tone: "success", text: "已清空全部用量统计" }
      : reset.state.status === "error"
        ? { tone: "error", text: reset.state.message }
        : null;

  const tokensByWorker = new Map<string, { input: number; output: number }>();
  for (const p of data.daily.byWorker) {
    const t = tokensByWorker.get(p.key) ?? { input: 0, output: 0 };
    t.input += p.inputTokens;
    t.output += p.outputTokens;
    tokensByWorker.set(p.key, t);
  }
  const workerRows: WorkerRow[] = data.workers.map((w) => ({ ...w, ...(tokensByWorker.get(w.workerId) ?? { input: 0, output: 0 }) }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="用量"
        status={data.sinceDay === null ? "全部历史" : `${data.sinceDay} 起（UTC 日）`}
        action={
          <div className={SEGMENTED_TRACK} role="group" aria-label="时间范围">
            {USAGE_RANGES.map((opt) => (
              <FilterChip key={opt.value} active={days === opt.value} onClick={() => onDays(opt.value)} label={opt.label} />
            ))}
          </div>
        }
      />

      <Panel title="总览">
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {/* 请求与尝试必须分开：一条重试链是一个请求、多次尝试。 */}
          <Metric label="客户端请求" value={compact(data.requests)} hint="一条重试链算一个" />
          <Metric label="上游尝试" value={compact(data.attempts)} hint="每次换 Worker 算一次" />
          <Metric
            label="缓存命中"
            value={rate(data.rates.cacheHitRate)}
            hint={data.rates.cacheHitRate === null ? "还没有带用量的请求" : "命中读 ÷ 总输入"}
          />
          <Metric
            label="用量覆盖"
            value={rate(data.rates.usageCoverage)}
            hint={data.rates.usageCoverage === null ? "还没有任何请求" : "上游报了用量的比例"}
          />
        </div>
        {data.rates.droppedUsageCount > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <span className="inline-flex items-center gap-1">
              <StatusIndicator tone="warn" icon="!" label={`${data.rates.droppedUsageCount} 次响应网关未完整解析，token 未计入`} />
              <HintTip label="未完整解析说明">
                这些响应过大或中途断流，网关没能读到其中的用量；<Strong>不是</Strong>上游没报。它们的 token 数没有计入统计。
              </HintTip>
            </span>
          </div>
        )}
      </Panel>

      <Panel
        title="按天"
        hint="图表与表格随上方的时间范围变化。按 Worker 时，表格里的尝试、成功与失败是 Worker 的累计值，不随时间范围变化；token 随时间范围。"
        action={
          <span className="flex flex-wrap items-center gap-2">
            <div className={SEGMENTED_TRACK} role="group" aria-label="系列">
              <FilterChip active={view.by === "model"} onClick={() => onView({ ...view, by: "model" })} label="按模型" />
              <FilterChip active={view.by === "worker"} onClick={() => onView({ ...view, by: "worker" })} label="按 Worker" />
            </div>
            <div className={SEGMENTED_TRACK} role="group" aria-label="图形">
              <FilterChip active={view.shape === "line"} onClick={() => onView({ ...view, shape: "line" })} label="面积" />
              <FilterChip active={view.shape === "bar"} onClick={() => onView({ ...view, shape: "bar" })} label="柱状" />
            </div>
            <select
              aria-label="指标"
              value={view.metric}
              onChange={(e) => onView({ ...view, metric: e.target.value as ChartMetric })}
              className={FIELD}
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ))}
            </select>
          </span>
        }
      >
        <UsageChart
          points={view.by === "model" ? data.daily.byModel : data.daily.byWorker}
          sinceDay={data.sinceDay}
          metric={view.metric}
          shape={view.shape}
          seriesLabel={view.by === "model" ? "模型" : "Worker"}
        />
        <div className="mt-5 border-t border-border pt-4">
          {view.by === "model" ? (
            data.models.length === 0 ? null : (
              <SimpleTable label="按模型用量" rows={data.models} columns={MODEL_COLUMNS} rowKey={(m) => m.model} rowAttr="data-model" />
            )
          ) : workerRows.length === 0 ? (
            <p className="text-text-muted">还没有上游尝试记录。</p>
          ) : (
            <>
              <SimpleTable label="按 Worker 用量" rows={workerRows} columns={WORKER_COLUMNS} rowKey={(w) => w.workerId} rowAttr="data-worker-stat" />
            </>
          )}
        </div>
      </Panel>

      <Panel
        title={`网关拒绝（${totalRejections}）`}
        hint={
          <>
            这些请求<Strong>从未到达上游</Strong>：网关在本机就拒了，不计入上游尝试。「不是免费模型」多半是客户端选了付费模型，
            点模型名到模型页看判定依据；「已下架」要从模型页的无后缀免费名单（<Mono>extraFreeIds</Mono>）里删掉那个条目。
          </>
        }
      >
        {totalRejections === 0 ? (
          <p className="text-text-muted">这段时间没有请求被网关自己挡下 —— 所有请求都到了上游。</p>
        ) : (
          <>
            <SimpleTable
              label="网关拒绝明细"
              rows={data.rejectedModels}
              columns={REJECTION_COLUMNS}
              rowKey={(r) => `${r.reason} ${r.model}`}
              rowAttr="data-rejection"
            />
          </>
        )}
      </Panel>

      {/* 清空全部统计放在页尾：破坏性操作不与高频的时间范围切换挨着，避免误点。 */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <SecondaryButton danger disabled={reset.state.status === "running"} onClick={() => setConfirming(true)}>
          重置统计
        </SecondaryButton>
        <span className="text-label-13 text-text-muted">清空全部用量，不只是当前时间范围。</span>
        <FormStatus message={resetMessage} />
      </div>

      <ConfirmDialog
        open={confirming}
        title="重置用量统计"
        confirmLabel="确认重置"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void reset.run().then((r) => {
            if (r !== null) onReset?.();
          });
        }}
      >
        <p>
          将清空<Strong>全部</Strong>用量统计（不只是当前时间范围）：请求与尝试记录、按模型与按 Worker 的 token、会话用量、网关拒绝计数。
        </p>
        <p>出口探测结果、会话亲和与配置不受影响，转发照常。此操作不能撤销。</p>
      </ConfirmDialog>
    </div>
  );
}
