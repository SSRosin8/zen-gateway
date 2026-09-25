import type { ReactNode } from "react";
import { Mono, RowMark } from "./Panel.tsx";

/**
 * 密集表格 —— 分页 + 搜索 + 状态筛选。
 *
 * ## 分页是**必需项**，不是可选
 *
 * 密度选宽松（行高 44px、正文 14px）是忠于 Anthropic 的透气观感，
 * 直接后果是**一屏约 12 行**，而代理池可能有几十个节点（本机实测 69 个）。
 * 所以默认页长定为 **12，与「一屏 12 行」的算术对齐** ——
 * 规划里先前写 20，那与自己的密度结论矛盾。
 *
 * ## 为什么不用 TanStack Table
 *
 * 依赖已经装着（规划指定它承接密集表格），但这一批需要的是
 * 「过滤 + 排序 + 切片」三个数组操作，而 TanStack 的价值在列定义、
 * 虚拟化、复杂状态。这里每张表 4-6 列、数据量几十行 ——
 * 引入它会让一个 30 行的需求变成一套 column helper 概念。
 *
 * **出口隔离视图是例外**（规划明确）：那个任务本身就是「一眼看全、
 * 找出共用出口的节点」，分页会破坏它的意义 —— 所以那个视图不分页。
 */

/** 默认页长。与「一屏 12 行」的算术对齐 —— 见文件头。 */
export const PAGE_SIZE = 12;

export type Column<T> = {
  readonly key: string;
  readonly header: string;
  /** 数字列右对齐 + `tabular-nums`（延迟、token 数、计数逐位可比）。 */
  readonly numeric?: boolean;
  readonly render: (row: T) => ReactNode;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowTone,
  page,
  onPageChange,
  empty,
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  /** 行状态 —— 用 3px 左边框实色表达，不用背景色块（见 `RowMark`）。 */
  rowTone?: (row: T) => "success" | "warn" | "error" | "neutral" | null;
  page: number;
  onPageChange: (page: number) => void;
  empty: ReactNode;
}) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  /*
   * 页码越界时夹回来。
   *
   * URL 是视图状态的唯一来源,所以 `page` 可能来自一个手打的链接
   * (`?page=99`),也可能是筛选之后行数变少了 —— 后者是常态:用户在第 3 页
   * 输入搜索词,结果只剩 5 行。不夹的话会显示一个空表,而用户不知道
   * 是「没有匹配」还是「翻过头了」。
   */
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  if (rows.length === 0) {
    return <div className="rounded-md bg-surface-accent px-4 py-6 text-center">{empty}</div>;
  }

  return (
    <div>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border-strong text-text-muted">
            {columns.map((col) => (
              <th
                key={col.key}
                className="py-2 font-medium"
                {...(col.numeric === true ? { "data-numeric": "" } : {})}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {slice.map((row) => {
            const tone = rowTone?.(row) ?? null;
            return (
              <tr
                key={rowKey(row)}
                className="relative border-b border-border last:border-0"
                /* 行高 44px：宽松密度，同时满足触摸目标 ≥44px。 */
                style={{ height: "44px" }}
                data-row={rowKey(row)}
              >
                {columns.map((col, i) => (
                  <td
                    key={col.key}
                    className={i === 0 ? "pl-3" : ""}
                    {...(col.numeric === true ? { "data-numeric": "" } : {})}
                  >
                    {i === 0 && tone !== null && <RowMark tone={tone} />}
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-text-muted">
          <span>
            第 {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} 条，
            共 {rows.length} 条
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange(current - 1)}
              disabled={current === 1}
              className="min-h-[44px] rounded-xs border border-border-strong px-3 disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted"
            >
              上一页
            </button>
            <span>
              <Mono>
                {current}/{totalPages}
              </Mono>
            </span>
            <button
              type="button"
              onClick={() => onPageChange(current + 1)}
              disabled={current === totalPages}
              className="min-h-[44px] rounded-xs border border-border-strong px-3 disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted"
            >
              下一页
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 搜索框 + 状态筛选。
 *
 * 两者都写进 URL（视图状态的唯一来源），所以它们是**受控**的 ——
 * 组件自己不留状态。留一份本地状态会与 URL 分叉，症状是「刷新后搜索词还在
 * 输入框里但列表没过滤」。
 */
export function TableFilters({
  q,
  onQ,
  status,
  onStatus,
  statuses,
  placeholder,
}: {
  q: string;
  onQ: (q: string) => void;
  status: string | null;
  onStatus: (status: string | null) => void;
  statuses: ReadonlyArray<{ value: string; label: string }>;
  placeholder: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={q}
        onChange={(e) => onQ(e.target.value)}
        placeholder={placeholder}
        aria-label="搜索"
        className="min-h-[44px] flex-1 rounded-sm border border-border-strong bg-bg px-3"
      />
      <div className="flex flex-wrap gap-1">
        <FilterChip active={status === null} onClick={() => onStatus(null)} label="全部" />
        {statuses.map((s) => (
          <FilterChip
            key={s.value}
            active={status === s.value}
            onClick={() => onStatus(s.value)}
            label={s.label}
          />
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[44px] rounded-xs border px-3 ${
        active
          ? "border-accent-fg text-accent-fg font-medium"
          : "border-border-strong text-text-muted"
      }`}
    >
      {label}
    </button>
  );
}
