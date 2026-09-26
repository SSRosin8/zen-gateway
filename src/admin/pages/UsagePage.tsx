import type { StatsView } from "../../shared/contract.ts";
import { Metric, Mono, Panel, Strong } from "../components/Panel.tsx";
import { FilterChip, SimpleTable, type Column } from "../components/DataTable.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";

/**
 * 用量页。
 *
 * ## 三处「不估算」的地方，每一处都比数字本身重要
 *
 * 1. **请求 ≠ 尝试**：一条 `w1 限流 → w2 成功` 的重试链是**一个**请求、
 *    **两次**尝试。两个数字都显示，且标注清楚。
 * 2. **缺失的 usage 如实显示为缺失**：免费模型的响应未必带 usage。
 *    把没报的按均值补上会让「缓存命中率」凭空变好看。
 * 3. **「未完整解析」单独一栏**：那是网关没能读完整个响应（响应过大或中途断流），
 *    不是上游没报。前者是网关侧的限制，后者是上游的行为，排查方向不同。
 */

/** 比值的显示。**null 是「没有数据」而不是 0%** —— 显示为「—」。 */
function rate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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

const MODEL_COLUMNS: ReadonlyArray<Column<ModelStat>> = [
  { key: "model", header: "模型", render: (m) => <Mono>{m.model}</Mono> },
  { key: "in", header: "输入", numeric: true, render: (m) => compact(m.inputTokens) },
  { key: "out", header: "输出", numeric: true, render: (m) => compact(m.outputTokens) },
  { key: "cache", header: "命中读", numeric: true, render: (m) => compact(m.cacheReadTokens) },
  { key: "with", header: "有用量", numeric: true, render: (m) => m.requestsWithUsage },
  // 「上游未报」与「未完整解析」分两列 —— 一个是上游的行为，一个是网关侧的限制。
  { key: "without", header: "未报", numeric: true, render: (m) => m.requestsWithoutUsage },
  {
    key: "dropped",
    header: "未完整解析",
    numeric: true,
    render: (m) => (
      <span className={m.requestsDroppedUsage > 0 ? "text-warn" : ""}>{m.requestsDroppedUsage}</span>
    ),
  },
];

const WORKER_COLUMNS: ReadonlyArray<Column<WorkerStat>> = [
  { key: "id", header: "Worker", render: (w) => <Mono>{w.workerId}</Mono> },
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
    render: (w) =>
      w.lastStatus === null ? <span className="text-text-muted">—</span> : <Mono>{w.lastStatus}</Mono>,
  },
];

export function UsagePage({
  data,
  days,
  onDays,
}: {
  data: StatsView;
  days: string;
  onDays: (days: string) => void;
}) {
  const totalRejections = Object.values(data.rejections).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <Panel
        title="用量"
        action={
          <div className="flex gap-1" role="group" aria-label="时间范围">
            {[
              { value: "7", label: "7 天" },
              { value: "30", label: "30 天" },
              { value: "all", label: "全部" },
            ].map((opt) => (
              <FilterChip
                key={opt.value}
                active={days === opt.value}
                onClick={() => onDays(opt.value)}
                label={opt.label}
              />
            ))}
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {/*
            请求与尝试**必须分开显示** —— 一条重试链是一个请求、多次尝试。
            合成一个数会让「上游失败率」这类判断建立在错误的分母上。
          */}
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

        <p className="mt-5 border-t border-border pt-4 text-text-muted">
          统计范围：
          {data.sinceDay === null ? "全部历史" : `${data.sinceDay} 起`}
          {data.sinceDay !== null && "。选「全部」统计全部历史，数据多时会慢一些。"}
        </p>

        {data.rates.droppedUsageCount > 0 && (
          <div className="mt-3">
            <StatusIndicator
              tone="warn"
              icon="!"
              label={`${data.rates.droppedUsageCount} 次响应网关未完整解析`}
            />
            <p className="mt-1 text-text-muted">
              这些响应过大或中途断流，网关没能读到其中的用量；<Strong>不是</Strong>上游没报。
              它们的 token 数没有计入上面的统计。
            </p>
          </div>
        )}
      </Panel>

      <Panel title={`按模型（${data.models.length}）`}>
        {data.models.length === 0 ? (
          <div className="rounded-md bg-surface-accent px-4 py-6 text-center">
            <p className="font-serif text-lg">这段时间还没有用量</p>
            <p className="mt-1 text-text-muted">
              跑一次 <Mono>opencode run</Mono> 之后回来看。
            </p>
          </div>
        ) : (
          <SimpleTable
            label="按模型用量"
            rows={data.models}
            columns={MODEL_COLUMNS}
            rowKey={(m) => m.model}
            rowAttr="data-model"
          />
        )}
      </Panel>

      <Panel title={`按 Worker（${data.workers.length}）`}>
        {data.workers.length === 0 ? (
          <p className="text-text-muted">还没有上游尝试记录。</p>
        ) : (
          <SimpleTable
            label="按 Worker 用量"
            rows={data.workers}
            columns={WORKER_COLUMNS}
            rowKey={(w) => w.workerId}
            rowAttr="data-worker-stat"
          />
        )}
      </Panel>

      <Panel title={`网关拒绝（${totalRejections}）`}>
        {totalRejections === 0 ? (
          <p className="text-text-muted">
            这段时间没有请求被网关自己挡下 —— 所有请求都到了上游。
          </p>
        ) : (
          <>
            <p className="mb-3 text-text-muted">
              这些请求<Strong>从未到达上游</Strong> —— 网关在本机就拒了。它们不计入上游尝试。
            </p>
            <ul className="space-y-1">
              {Object.entries(data.rejections)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => (
                  <li key={reason} className="flex justify-between" data-rejection={reason}>
                    <span>{REJECTION_LABEL[reason] ?? reason}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{count}</span>
                  </li>
                ))}
            </ul>
            {data.rejections["not_free"] !== undefined && data.rejections["retired"] !== undefined && (
              <p className="mt-3 text-text-muted">
                <Strong>「不是免费模型」与「已下架」的处置不同</Strong>：前者改客户端用的模型名，
                后者从模型页的无后缀免费名单（<Mono>extraFreeIds</Mono>）里删掉那个条目。
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
