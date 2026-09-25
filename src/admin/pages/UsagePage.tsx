import type { StatsView } from "../../shared/contract.ts";
import { Metric, Mono, Panel, Strong } from "../components/Panel.tsx";
import { StatusIndicator } from "../components/StatusIndicator.tsx";

/**
 * 用量页 —— Phase 7 的聚合终于有了界面。
 *
 * ## 三处「不估算」的地方，每一处都比数字本身重要
 *
 * 1. **请求 ≠ 尝试**：一条 `w1 限流 → w2 成功` 的重试链是**一个**请求、
 *    **两次**尝试。两个数字都显示，且标注清楚 —— 这是本页最容易被当成
 *    同一个量的两个数。
 * 2. **缺失的 usage 如实显示为缺失**：免费模型的响应未必带 usage。
 *    把没报的按均值补上会让「缓存命中率」凭空变好看，而那比没有数字更糟。
 * 3. **`dropped` 单独一栏**：那是**我们自己**没解析完整（响应过大/中途断流），
 *    不是上游没报。处置方向相反 —— 前者要改我们的界定常量，后者不用改。
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
          <div className="flex gap-1">
            {[
              { value: "7", label: "7 天" },
              { value: "30", label: "30 天" },
              { value: "all", label: "全部" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onDays(opt.value)}
                aria-pressed={days === opt.value}
                className={`min-h-[44px] rounded-xs border px-3 ${
                  days === opt.value
                    ? "border-accent-fg text-accent-fg font-medium"
                    : "border-border-strong text-text-muted"
                }`}
              >
                {opt.label}
              </button>
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
          {data.sinceDay !== null && (
            <>
              {" "}
              —— 默认带时间窗是<Strong>刻意的</Strong>：那个请求计数要全表扫（
              <Mono>COUNT(DISTINCT request_id)</Mono>）且是同步调用，
              不限范围会阻塞事件循环。
            </>
          )}
        </p>

        {data.rates.droppedUsageCount > 0 && (
          <div className="mt-3">
            <StatusIndicator
              tone="warn"
              icon="!"
              label={`${data.rates.droppedUsageCount} 次响应我们没解析完整`}
            />
            <p className="mt-1 text-text-muted">
              这是<Strong>我们自己</Strong>丢了用量（响应过大或中途断流），<Strong>不是</Strong>上游没报 ——
              两者的处置方向相反。非 0 说明要看我们的界定常量。
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
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border-strong text-text-muted">
                <th className="py-2 font-medium">模型</th>
                <th className="py-2 font-medium" data-numeric="">输入</th>
                <th className="py-2 font-medium" data-numeric="">输出</th>
                <th className="py-2 font-medium" data-numeric="">命中读</th>
                <th className="py-2 font-medium" data-numeric="">有用量</th>
                <th className="py-2 font-medium" data-numeric="">未报</th>
                <th className="py-2 font-medium" data-numeric="">我们丢了</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr
                  key={m.model}
                  className="border-b border-border last:border-0"
                  style={{ height: "44px" }}
                  data-model={m.model}
                >
                  <td>
                    <Mono>{m.model}</Mono>
                  </td>
                  <td data-numeric="">{compact(m.inputTokens)}</td>
                  <td data-numeric="">{compact(m.outputTokens)}</td>
                  <td data-numeric="">{compact(m.cacheReadTokens)}</td>
                  <td data-numeric="">{m.requestsWithUsage}</td>
                  {/* 「上游没报」与「我们丢了」分两列 —— 处置方向相反。 */}
                  <td data-numeric="">{m.requestsWithoutUsage}</td>
                  <td data-numeric="" className={m.requestsDroppedUsage > 0 ? "text-warn" : ""}>
                    {m.requestsDroppedUsage}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`按 Worker（${data.workers.length}）`}>
        {data.workers.length === 0 ? (
          <p className="text-text-muted">还没有上游尝试记录。</p>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border-strong text-text-muted">
                <th className="py-2 font-medium">Worker</th>
                <th className="py-2 font-medium" data-numeric="">尝试</th>
                <th className="py-2 font-medium" data-numeric="">成功</th>
                <th className="py-2 font-medium" data-numeric="">失败</th>
                <th className="py-2 font-medium" data-numeric="">最近状态码</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr
                  key={w.workerId}
                  className="border-b border-border last:border-0"
                  style={{ height: "44px" }}
                  data-worker-stat={w.workerId}
                >
                  <td>
                    <Mono>{w.workerId}</Mono>
                  </td>
                  <td data-numeric="">{w.attempts}</td>
                  <td data-numeric="">{w.successes}</td>
                  <td data-numeric="" className={w.failures > 0 ? "text-warn" : ""}>
                    {w.failures}
                  </td>
                  <td data-numeric="">
                    {w.lastStatus === null ? (
                      <span className="text-text-muted">—</span>
                    ) : (
                      <Mono>{w.lastStatus}</Mono>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                后者删 <Mono>extraFreeIds</Mono> 里那个条目。哪种多正是
                「该改文档还是该改配置」的那个数字。
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
