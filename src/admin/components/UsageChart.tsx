import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DailyPoint } from "../../shared/contract.ts";

/**
 * 用量图表：按天的一张图，堆叠面积图 / 堆叠柱状图切换，按模型或按 Worker 分系列。
 *
 * 依 dataviz 规范：
 * - 系列色（`--color-series-N`）按名字的散列取槽，色随实体不随名次；可见系列撞槽时顺延到下一个空槽，
 *   所以同屏颜色一定互不相同，只有撞槽的那个在换时间窗时可能换色
 *   （按全部系列名排序分配，而不是按当前可见的名次）。
 * - 超过 7 个系列把其余并为「其他」，不生成第 9 种颜色。
 * - 单一 y 轴；两种形状都堆叠，顶边就是当天合计，切换形状时 y 轴不变。面积填充取系列色的
 *   浅一档（`fill-opacity`，只在 SVG 内），上沿再描 2px 实色线，重叠处不靠透明叠色区分。
 * - 柱最宽 24px、柱顶 4px 圆角、相邻柱与堆叠段之间 2px 表面间隙。
 * - 文字一律用文字 token，不用系列色；图例常在（≥2 个系列）。
 * - 悬停：面积图用竖线跟随最近的一天，柱图每根柱是命中区；键盘可逐天移动。提示框里值在前、名在后。
 * - 另有数据表视图（`showTable`），提示框里的每个数都能不悬停就读到。
 *
 * - 按容器实际宽度作画（`useWidth`），不是固定画布整体缩放：刻度字在任何宽度下都是 11px。
 *   横轴从这段时间里第一天有数据时开始，之前全是 0 的日子不占宽度（页头已写明时间范围）。
 *
 * 不引图表库：一张图、两种形状，内联 SVG 足够，也不给构建链加依赖。
 * 形状值保留 `line` 作为面积图的 URL 取值：已分享的链接（`shape=line`）不失效。
 */

export type Metric = "tokens" | "input" | "output" | "cache" | "requests";
export type Shape = "line" | "bar";

export const METRIC_LABEL: Record<Metric, string> = {
  tokens: "总 token（输入 + 输出）",
  input: "输入 token",
  output: "输出 token",
  cache: "缓存读 token",
  requests: "请求数",
};

const MAX_SERIES = 7;
const OTHER = "其他";

function valueOf(p: DailyPoint, metric: Metric): number {
  switch (metric) {
    case "tokens":
      return p.inputTokens + p.outputTokens;
    case "input":
      return p.inputTokens;
    case "output":
      return p.outputTokens;
    case "cache":
      return p.cacheReadTokens;
    case "requests":
      return p.requests;
  }
}

/**
 * 从这段时间里第一天有数据的日子到今天（UTC）的每一天。选 30 天而只有最近两天有用量时，
 * 横轴不再有 28 天贴底的空白；没有数据时返回空。
 */
export function dayAxis(points: readonly DailyPoint[], sinceDay: string | null, today = new Date()): string[] {
  const first = points.reduce<string | null>(
    (m, p) => ((sinceDay === null || p.day >= sinceDay) && (m === null || p.day < m) ? p.day : m),
    null,
  );
  if (first === null) return [];
  const end = today.toISOString().slice(0, 10);
  const out: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    if (key > end || out.length > 3660) break;
    out.push(key);
  }
  return out;
}

export type Series = { key: string; slot: number | null; values: number[]; total: number };

/**
 * 整理成系列：按总量取前 7 个，其余并为「其他」。颜色槽见文件头（与名次无关），
 * 「其他」用中性灰（slot null）。
 */
export function buildSeries(points: readonly DailyPoint[], days: readonly string[], metric: Metric): Series[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const byKey = new Map<string, number[]>();
  for (const p of points) {
    const i = index.get(p.day);
    if (i === undefined) continue;
    const row = byKey.get(p.key) ?? new Array<number>(days.length).fill(0);
    row[i]! += valueOf(p, metric);
    byKey.set(p.key, row);
  }
  const all = [...byKey].map(([key, values]) => ({ key, values, total: values.reduce((a, b) => a + b, 0) }));
  const ranked = all.filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
  const head = ranked.slice(0, ranked.length > MAX_SERIES + 1 ? MAX_SERIES : ranked.length);
  const tail = ranked.slice(head.length);
  // 按名字顺序分槽（而不是名次），同一组可见系列无论排名怎么变，分到的槽都一样。
  const taken = new Set<number>();
  const slots = new Map<string, number>();
  for (const key of head.map((s) => s.key).sort()) {
    let slot = hashSlot(key);
    while (taken.has(slot)) slot = (slot + 1) % SLOTS;
    taken.add(slot);
    slots.set(key, slot);
  }
  const out: Series[] = head.map((s) => ({ ...s, slot: slots.get(s.key)! }));
  if (tail.length > 0) {
    const values = days.map((_, i) => tail.reduce((a, s) => a + s.values[i]!, 0));
    out.push({ key: `${OTHER}（${tail.length}）`, slot: null, values, total: values.reduce((a, b) => a + b, 0) });
  }
  return out;
}

/** 系列色槽数，对应 `--zg-series-1..8`；可见系列最多 7 个，总有空槽。 */
const SLOTS = 8;

function hashSlot(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % SLOTS;
}

export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** 取整的刻度：1/2/5 × 10^k，4 段左右。 */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * 过各点的平滑曲线（单调三次插值，逐段三次贝塞尔）。单调插值不会越过相邻两点的值：
 * 普通样条在骤增骤降处会冲过头，堆叠面积就会低于 0 或压进下一层。
 * 相邻两层共用同一组点，所以上一层的上沿与下一层的下沿是同一条曲线，层间不留缝。
 * 反向传入得到同一条曲线（切线随方向取反），用于面积的回程边。
 */
export function smoothPath(p: ReadonlyArray<readonly [number, number]>): string {
  const f = (n: number) => n.toFixed(1);
  if (p.length === 0) return "";
  if (p.length < 3) return `M${p.map(([a, b]) => `${f(a)},${f(b)}`).join(" L")}`;
  const slope = p.slice(1).map(([x1, y1], i) => (y1 - p[i]![1]) / (x1 - p[i]![0]));
  const tangent = p.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === p.length - 1) return slope[i - 1]!;
    const a = slope[i - 1]!;
    const b = slope[i]!;
    // 转折点（或一侧持平）切线为 0，曲线在那里走平；否则取调和平均，保证不冲过头。
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  let d = `M${f(p[0]![0])},${f(p[0]![1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i]!;
    const [x1, y1] = p[i + 1]!;
    const h = (x1 - x0) / 3;
    d += ` C${f(x0 + h)},${f(y0 + tangent[i]! * h)} ${f(x1 - h)},${f(y1 - tangent[i + 1]! * h)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** 画布默认宽度：jsdom 没有布局、首帧还没量到时用它。 */
const DEFAULT_WIDTH = 960;

/**
 * 元素的内容宽度，随尺寸变化更新。用回调 ref：图表在「没有用量」时不渲染容器，
 * 数据到了才挂上，固定的 ref 对象在那之前跑完的 effect 不会再观察它。
 */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    if (el === null) return;
    // 挂上时先同步量一次：ResizeObserver 的首次回调要等下一帧渲染，页面在后台标签时不会来。
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

const color = (slot: number | null) => (slot === null ? "var(--zg-border-strong)" : `var(--zg-series-${slot + 1})`);

export function UsageChart({
  points,
  sinceDay,
  metric,
  shape,
  seriesLabel,
  today,
}: {
  points: readonly DailyPoint[];
  sinceDay: string | null;
  metric: Metric;
  shape: Shape;
  /** 图例与表格里「系列」一列的名字（模型 / Worker）。 */
  seriesLabel: string;
  /** 时间轴的终点；测试注入固定日期，页面用当前时间。 */
  today?: Date;
}) {
  const days = useMemo(() => dayAxis(points, sinceDay, today), [points, sinceDay, today]);
  const series = useMemo(() => buildSeries(points, days, metric), [points, days, metric]);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxRef, W] = useWidth();
  const titleId = useId();

  if (days.length === 0 || series.length === 0) {
    return <p className="py-10 text-center text-text-muted">这段时间还没有用量。跑一次 opencode run 之后回来看。</p>;
  }

  const H = 280;
  const pad = { l: 48, r: 12, t: 12, b: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const totals = days.map((_, i) => series.reduce((a, s) => a + s.values[i]!, 0));
  const max = Math.max(...totals);
  const { top, step } = niceMax(max);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const band = iw / days.length;
  const x = (i: number) => pad.l + band * (i + 0.5);
  const barW = Math.min(24, Math.max(2, band - 2));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  // 日期标签（「09-27」）约 40px 宽，每个至少留 64px，容器窄时不会挤在一起。
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(iw / 64))));

  const pick = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const px = ((clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - pad.l) / band);
    setHover(i >= 0 && i < days.length ? i : null);
  };

  const hovered = hover === null ? null : { day: days[hover]!, rows: series.map((s) => ({ s, v: s.values[hover]! })).filter((r) => r.v > 0) };

  return (
    <div className="space-y-3" data-usage-chart={shape}>
      {/* 图例：≥2 个系列才有；两种形状都是填充，所以都用方块。 */}
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="图例">
          {series.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-2 text-label-13">
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-[3px]"
                style={{ backgroundColor: color(s.slot) }}
              />
              <span className="font-mono">{s.key}</span>
              <span className="text-text-muted">{compact(s.total)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="relative" ref={boxRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-labelledby={titleId}
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX)}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setHover((h) => Math.min(days.length - 1, (h ?? -1) + 1));
            else if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? days.length) - 1));
            else if (e.key === "Escape") setHover(null);
            else return;
            e.preventDefault();
          }}
        >
          <title id={titleId}>{`${METRIC_LABEL[metric]}，按天，按${seriesLabel}`}</title>
          {/* 网格：实线细线，一步离开表面色；y 轴刻度取整。 */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--zg-border)" strokeWidth={1} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--zg-text-muted)" style={{ fontVariantNumeric: "tabular-nums" }}>
                {compact(t)}
              </text>
            </g>
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--zg-border-strong)" strokeWidth={1} />
          {days.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--zg-text-muted)">
                {d.slice(5)}
              </text>
            ) : null,
          )}

          {hover !== null && shape === "line" && (
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--zg-border-strong)" strokeWidth={1} />
          )}
          {hover !== null && shape === "bar" && (
            <rect x={pad.l + band * hover} y={pad.t} width={band} height={ih} fill="var(--zg-surface-hover)" />
          )}

          {shape === "line"
            ? (() => {
                // 堆叠面积：每个系列的下沿是前面系列的累计，上沿再加上自己。自底向上画，
                // 上沿线最后画，让后画的面积不盖住前一个系列的边线。
                const base = new Array<number>(days.length).fill(0);
                const layers = series.map((s) => {
                  const lower = [...base];
                  s.values.forEach((v, i) => (base[i]! += v));
                  return { s, lower, upper: [...base] };
                });
                const pts = (arr: number[]) => arr.map((v, i) => [x(i), y(v)] as const);
                return (
                  <g>
                    {layers.map(({ s, lower, upper }) => (
                      <path
                        key={`area-${s.key}`}
                        d={`${smoothPath(pts(upper))} L${smoothPath(pts(lower).reverse()).slice(1)} Z`}
                        fill={color(s.slot)}
                        fillOpacity={0.35}
                      />
                    ))}
                    {layers.map(({ s, upper }) => (
                      <path key={`edge-${s.key}`} d={smoothPath(pts(upper))} fill="none" stroke={color(s.slot)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    ))}
                    {hover !== null &&
                      layers
                        .filter(({ s }) => s.values[hover]! > 0)
                        .map(({ s, upper }) => (
                          <circle key={`dot-${s.key}`} cx={x(hover)} cy={y(upper[hover]!)} r={4} fill={color(s.slot)} stroke="var(--zg-surface)" strokeWidth={2} />
                        ))}
                    {/* 只有一天时面积没有宽度，画出端点让它看得见。 */}
                    {days.length === 1 &&
                      layers.map(({ s, upper }) => <circle key={`one-${s.key}`} cx={x(0)} cy={y(upper[0]!)} r={4} fill={color(s.slot)} stroke="var(--zg-surface)" strokeWidth={2} />)}
                  </g>
                );
              })()
            : days.map((dayKey, i) => {
                // 堆叠：自底向上，段与段之间留 2px 表面色间隙；最上一段顶部 4px 圆角。
                let base = 0;
                const segs = series
                  .map((s) => ({ s, v: s.values[i]! }))
                  .filter((r) => r.v > 0);
                return (
                  <g key={dayKey}>
                    {segs.map((r, k) => {
                      const y0 = y(base);
                      base += r.v;
                      const y1 = y(base);
                      const h = Math.max(0, y0 - y1 - (k < segs.length - 1 ? 2 : 0));
                      const topSeg = k === segs.length - 1;
                      const bx = x(i) - barW / 2;
                      const rr = topSeg ? Math.min(4, h, barW / 2) : 0;
                      const path =
                        rr > 0
                          ? `M${bx},${y0} V${y0 - h + rr} Q${bx},${y0 - h} ${bx + rr},${y0 - h} H${bx + barW - rr} Q${bx + barW},${y0 - h} ${bx + barW},${y0 - h + rr} V${y0} Z`
                          : `M${bx},${y0} V${y0 - h} H${bx + barW} V${y0} Z`;
                      return <path key={r.s.key} d={path} fill={color(r.s.slot)} />;
                    })}
                  </g>
                );
              })}
        </svg>

        {hovered !== null && hovered.rows.length > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute top-2 z-10 min-w-44 rounded-md border border-border-strong bg-surface px-3 py-2 shadow-float"
            style={hover! < days.length / 2 ? { left: `${((x(hover!) + 12) / W) * 100}%` } : { right: `${((W - x(hover!) + 12) / W) * 100}%` }}
          >
            <p className="mb-1 text-label-12 text-text-muted">{hovered.day}</p>
            <ul className="space-y-0.5">
              {hovered.rows.map(({ s, v }) => (
                <li key={s.key} className="flex items-center gap-2 text-label-13">
                  <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: color(s.slot) }} />
                  <span className="font-medium" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {v.toLocaleString()}
                  </span>
                  <span className="font-mono text-text-muted">{s.key}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
