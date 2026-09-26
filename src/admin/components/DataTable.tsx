import { Fragment, type ReactNode } from "react";
import { Mono, RowMark, SecondaryButton } from "./Panel.tsx";

/**
 * 表格 —— 分页 + 搜索 + 状态筛选，以及不分页的 `SimpleTable`。
 *
 * ## 分页是必需项
 *
 * 密度选宽松（行高 44px、正文 14px），直接后果是**一屏约 12 行**，而代理池
 * 可能有几十个节点。所以默认页长与「一屏 12 行」的算术对齐。
 *
 * ## 为什么不用表格库
 *
 * 这里需要的是「过滤 + 排序 + 切片」三个数组操作，每张表 4-7 列、几十行。
 * 引入一个表格库会让一个 30 行的需求变成一套列定义概念。
 *
 * **出口隔离视图不分页**：那个任务本身就是「一眼看全、找出共用出口的节点」，
 * 分页会破坏它的意义。
 *
 * ## 窄屏横向滚动
 *
 * 所有表格都包在 `TableScroll` 里：列数多于窄屏宽度时在面板内部横向滚动，
 * 而不是把整页撑宽（那会让导航和其他面板一起出现横向滚动条）。
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

type Tone = "success" | "warn" | "error" | "neutral";

/** 表格的横向滚动容器。`tabIndex` 让只用键盘的用户也能聚焦后用方向键滚动。 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

function numericAttr(numeric: boolean | undefined) {
  return numeric === true ? { "data-numeric": "" } : {};
}

/**
 * 表格主体。`DataTable` 与 `SimpleTable` 共用，保证行高、边框、状态标记一致。
 *
 * `expandedRowKey` / `renderExpanded` 在指定行正下方插入一行跨全部列的内容
 * （例如行内编辑表单），让编辑区紧贴被编辑的那一行。
 */
function TableBody<T>({
  label,
  rows,
  columns,
  rowKey,
  rowTone,
  rowAttr,
  expandedRowKey,
  renderExpanded,
}: {
  label: string;
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  rowTone?: ((row: T) => Tone | null) | undefined;
  rowAttr: string;
  expandedRowKey?: string | null | undefined;
  renderExpanded?: ((row: T) => ReactNode) | undefined;
}) {
  return (
    <TableScroll label={label}>
      <table className="w-full min-w-max border-collapse text-left">
        <thead>
          <tr className="border-b border-border-strong text-text-muted">
            {columns.map((col, i) => (
              <th
                key={col.key}
                className={`py-2 pr-4 font-medium last:pr-0 ${i === 0 ? "pl-3" : ""}`}
                {...numericAttr(col.numeric)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const tone = rowTone?.(row) ?? null;
            const expanded = expandedRowKey === key && renderExpanded !== undefined;
            return (
              <Fragment key={key}>
                <tr
                  className="relative border-b border-border last:border-0"
                  /* 行高 44px：宽松密度，同时满足触摸目标 ≥44px。 */
                  style={{ height: "44px" }}
                  {...{ [rowAttr]: key }}
                >
                  {columns.map((col, i) => (
                    <td
                      key={col.key}
                      className={`pr-4 last:pr-0 ${i === 0 ? "pl-3" : ""}`}
                      {...numericAttr(col.numeric)}
                    >
                      {i === 0 && tone !== null && <RowMark tone={tone} />}
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {expanded && (
                  <tr className="border-b border-border-strong" data-expanded={key}>
                    <td colSpan={columns.length} className="bg-bg px-3 py-4">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** 不分页的小表（Clash 内核、用量聚合、概览 Worker）。 */
export function SimpleTable<T>({
  label,
  rows,
  columns,
  rowKey,
  rowTone,
  rowAttr = "data-row",
}: {
  /** 滚动区域的无障碍名称。 */
  label: string;
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  rowTone?: (row: T) => Tone | null;
  /** 行上的 data 属性名，供测试与调试定位。 */
  rowAttr?: `data-${string}`;
}) {
  return (
    <TableBody
      label={label}
      rows={rows}
      columns={columns}
      rowKey={rowKey}
      rowTone={rowTone}
      rowAttr={rowAttr}
    />
  );
}

export function DataTable<T>({
  label,
  rows,
  columns,
  rowKey,
  rowTone,
  page,
  onPageChange,
  empty,
  expandedRowKey,
  renderExpanded,
}: {
  label: string;
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  /** 行状态 —— 用 3px 左边框实色表达，不用背景色块（见 `RowMark`）。 */
  rowTone?: (row: T) => Tone | null;
  page: number;
  onPageChange: (page: number) => void;
  empty: ReactNode;
  /** 在该行下方展开 `renderExpanded` 的内容；行不在当前页时不显示。 */
  expandedRowKey?: string | null;
  renderExpanded?: (row: T) => ReactNode;
}) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  /*
   * 页码越界时夹回来。
   *
   * `page` 可能来自手打的链接（`?page=99`），也可能是筛选之后行数变少了 ——
   * 后者是常态：用户在第 3 页输入搜索词，结果只剩 5 行。不夹的话会显示一个
   * 空表，而用户不知道是「没有匹配」还是「翻过头了」。
   */
  const current = Math.min(Math.max(1, page), totalPages);
  const slice = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  if (rows.length === 0) {
    return <div className="rounded-md bg-surface-accent px-4 py-6 text-center">{empty}</div>;
  }

  return (
    <div>
      <TableBody
        label={label}
        rows={slice}
        columns={columns}
        rowKey={rowKey}
        rowTone={rowTone}
        rowAttr="data-row"
        expandedRowKey={expandedRowKey}
        renderExpanded={renderExpanded}
      />

      {totalPages > 1 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-text-muted">
          <span>
            第 {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} 条，
            共 {rows.length} 条
          </span>
          <span className="flex items-center gap-2">
            <SecondaryButton onClick={() => onPageChange(current - 1)} disabled={current === 1}>
              上一页
            </SecondaryButton>
            <span>
              <Mono>
                {current}/{totalPages}
              </Mono>
            </span>
            <SecondaryButton
              onClick={() => onPageChange(current + 1)}
              disabled={current === totalPages}
            >
              下一页
            </SecondaryButton>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * 搜索框 + 状态筛选。
 *
 * 两者都写进 URL，所以是**受控**的 —— 组件自己不留状态。留一份本地状态会与
 * URL 分叉，症状是「刷新后搜索词还在输入框里但列表没过滤」。
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
        className="min-h-[44px] min-w-0 flex-1 basis-48 rounded-sm border border-border-strong bg-bg px-3"
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label="状态筛选">
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

/** 可切换的筛选片。选中态用 accent 描边 + 加粗 + `aria-pressed`，不只靠颜色。 */
export function FilterChip({
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
