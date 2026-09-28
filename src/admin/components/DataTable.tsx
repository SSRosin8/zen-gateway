import { Fragment, type ReactNode } from "react";
import { Mono, RowMark, SecondaryButton, Skeleton, Truncate } from "./Panel.tsx";
import { FIELD } from "../lib/styles.ts";

/**
 * 表格 —— 分页 + 搜索 + 状态筛选，以及不分页的 `SimpleTable`。
 *
 * ## 分页是必需项
 *
 * 紧凑密度（行高 36px、正文 14px）：1280×800 视口扣掉页头、导航、筛选与面板头后，
 * 表格区约 600px，放得下 16 行 + 表头，所以 `PAGE_SIZE` 取 16。代理池可能有几十个节点。
 *
 * ## 为什么不用表格库
 *
 * 这里需要的是「过滤 + 排序 + 切片」三个数组操作，每张表 4-7 列、几十行。
 * 引入一个表格库会让一个 30 行的需求变成一套列定义概念。
 *
 * 列表表（Worker、出口节点、订阅、Clash 内核、模型）都分页；`SimpleTable` 只给行数天然很少的
 * 聚合小表（用量按模型 / Worker、网关拒绝）。
 *
 * ## 横向滚动
 *
 * 所有表格都包在 `TableScroll` 里：列宽合计超过面板宽度时在面板内部横向滚动，
 * 而不是把整页撑宽（那会让导航和其他面板一起出现横向滚动条）。
 */

/** 默认页长。与「行高 36px → 一屏约 16 行」的算术对齐 —— 见文件头。 */
export const PAGE_SIZE = 16;

/** 表格行高（px）。与 tokens.css 的 `--spacing-row` 一致。 */
export const ROW_HEIGHT = 36;

export type Column<T> = {
  readonly key: string;
  readonly header: string;
  /** 数字列右对齐 + `tabular-nums`（延迟、token 数、计数逐位可比）。 */
  readonly numeric?: boolean;
  /**
   * 固定在右端（操作列）。表格比容器宽时在内部横向滚动，操作列不跟着滚出视野：
   * 窗口较窄时「编辑」「停用」始终点得到。只给最后一列用。
   */
  readonly pinEnd?: boolean;
  readonly render: (row: T) => ReactNode;
};

type Tone = "success" | "warn" | "error" | "neutral";

/**
 * 表格的滚动容器。`tabIndex` 让只用键盘的用户也能聚焦后用方向键滚动。
 *
 * 横向溢出让这个 div 成为滚动容器，表头的 `sticky top-0` 只能相对它生效，贴不到
 * 视口上。所以纵向也限高（视口高减 8rem，至少 20rem）：16 行 × 36px + 表头 ≈ 612px，
 * 800px 高的视口下不触发内部滚动；展开编辑表单或在矮屏上才滚，那时表头仍在。
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="max-h-[max(20rem,calc(100vh-8rem))] overflow-auto" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

function numericAttr(numeric: boolean | undefined) {
  return numeric === true ? { "data-numeric": "" } : {};
}

function pinAttr(pin: boolean | undefined) {
  return pin === true ? { "data-pin": "end" } : {};
}

/*
 * 固定列自带实色底（否则滚过去的内容会从底下透出来），所以行悬停色要由行的 group 传给它；
 * 左边框把它和滚动区分开。
 */
const PIN_END_HEAD = "sticky right-0 z-20 border-l border-border pl-3";
const PIN_END_CELL = "sticky right-0 z-[1] border-l border-border bg-surface pl-3 transition-colors group-hover:bg-surface-hover";

/**
 * 表格主体。`DataTable` 与 `SimpleTable` 共用，保证行高、边框、状态标记一致。
 *
 * `expandedRowKey` / `renderExpanded` 在指定行正下方插入一行跨全部列的内容
 * （例如行内编辑表单），让编辑区紧贴被编辑的那一行。
 */
/**
 * 多选：表头一个「全选本页」、每行一个复选框。选中集合归调用方（跨页保留），
 * 名称取 `rowLabel`，让读屏听到「选择 anon-3」而不是一串「复选框」。
 */
export type Selection = {
  readonly selected: ReadonlySet<string>;
  readonly onChange: (next: ReadonlySet<string>) => void;
  readonly rowLabel: (key: string) => string;
};

function TableBody<T>({
  label,
  rows,
  columns: rawColumns,
  rowKey,
  rowTone,
  rowAttr,
  expandedRowKey,
  renderExpanded,
  selection,
}: {
  label: string;
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  rowTone?: ((row: T) => Tone | null) | undefined;
  rowAttr: string;
  expandedRowKey?: string | null | undefined;
  renderExpanded?: ((row: T) => ReactNode) | undefined;
  selection?: Selection | undefined;
}) {
  const keys = rows.map(rowKey);
  const allOnPage = selection !== undefined && keys.length > 0 && keys.every((k) => selection.selected.has(k));
  const toggle = (ks: readonly string[], on: boolean) => {
    if (selection === undefined) return;
    const next = new Set(selection.selected);
    for (const k of ks) {
      if (on) next.add(k);
      else next.delete(k);
    }
    selection.onChange(next);
  };
  const columns: ReadonlyArray<Column<T> & { headerNode?: ReactNode }> =
    selection === undefined
      ? rawColumns
      : [
          {
            key: "__select",
            header: "选择",
            headerNode: (
              <input
                type="checkbox"
                aria-label="全选本页"
                checked={allOnPage}
                onChange={(e) => toggle(keys, e.target.checked)}
                className="h-4 w-4 align-middle"
              />
            ),
            render: (row: T) => {
              const k = rowKey(row);
              return (
                <input
                  type="checkbox"
                  aria-label={`选择 ${selection.rowLabel(k)}`}
                  checked={selection.selected.has(k)}
                  onChange={(e) => toggle([k], e.target.checked)}
                  className="h-4 w-4 align-middle"
                />
              );
            },
          },
          ...rawColumns,
        ];
  // 固定在右端的列只能是最后一列：放在中间会盖住它右边滚过来的列。
  if (columns.some((c, i) => c.pinEnd === true && i !== columns.length - 1)) {
    throw new Error(`表格 ${label} 的固定列必须是最后一列`);
  }
  return (
    <TableScroll label={label}>
      {/* border-separate + 单元格边框：border-collapse 下 sticky 表头的边框会留在原地
          不随单元格移动，而 tr 的边框只在 collapse 模式下绘制。 */}
      <table className="w-full min-w-max border-separate border-spacing-0 text-left">
        {/* 表头吸顶：实色底 + 下边框，不用阴影。 */}
        <thead>
          {/* 表头与数据行同高：`DataTable` 的整页固定高度按「表头 + PAGE_SIZE 行」算。 */}
          <tr className="text-label-12 text-text-muted" style={{ height: `${ROW_HEIGHT}px` }}>
            {columns.map((col, i) => (
              <th
                key={col.key}
                scope="col"
                className={`sticky top-0 z-10 border-b border-border-strong bg-surface pr-4 font-medium last:pr-3 ${i === 0 ? "pl-3" : ""} ${
                  col.pinEnd === true ? PIN_END_HEAD : ""
                }`}
                {...numericAttr(col.numeric)}
                {...pinAttr(col.pinEnd)}
              >
                {"headerNode" in col && col.headerNode !== undefined ? col.headerNode : col.header}
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
                  className="group relative transition-colors *:border-b *:border-border last:*:border-b-0 hover:bg-surface-hover"
                  /* 行高 36px：紧凑密度。行本身不是点击目标，行内按钮自带 ≥24px 的目标。 */
                  style={{ height: `${ROW_HEIGHT}px` }}
                  {...{ [rowAttr]: key }}
                >
                  {columns.map((col, i) => (
                    <td
                      key={col.key}
                      /* 不加纵向内边距：行高由 tr 的 36px 决定，单元格内容必须单行（≤32px 的行内按钮）。 */
                      className={`whitespace-nowrap pr-4 last:pr-3 ${i === 0 ? "pl-3" : ""} ${col.pinEnd === true ? PIN_END_CELL : ""}`}
                      {...numericAttr(col.numeric)}
                      {...pinAttr(col.pinEnd)}
                    >
                      {i === 0 && tone !== null && <RowMark tone={tone} />}
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
                {expanded && (
                  <tr data-expanded={key}>
                    <td colSpan={columns.length} className="border-b border-border-strong bg-surface-hover px-3 py-4">
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

/** 不分页的小表（用量聚合、网关拒绝明细）。 */
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
  selection,
  total,
}: {
  label: string;
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  /**
   * 筛选前的总行数。传入后，只要总数多于一页，表格区就固定为一整页的高度、分页栏常在：
   * 在「全部 / 可用 / 已拒绝」之间切换时行数变了，页面高度不跟着跳，筛选控件不被挤走。
   * 总数本来就不满一页时按实际行数显示，不留大块空白。
   */
  total?: number;
  /** 行状态 —— 用 3px 左边框实色表达，不用背景色块（见 `RowMark`）。 */
  rowTone?: (row: T) => Tone | null;
  /** 传入即启用多选列。 */
  selection?: Selection;
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

  const fixed = total !== undefined && total > PAGE_SIZE;
  // 表头与每行同高（ROW_HEIGHT），一页固定为「表头 + PAGE_SIZE 行」。
  const pageHeight = fixed ? { minHeight: `${(PAGE_SIZE + 1) * ROW_HEIGHT}px` } : undefined;

  if (rows.length === 0) {
    return (
      <div style={pageHeight} className="flex flex-col justify-center rounded-md bg-surface-accent px-4 py-6 text-center">
        {empty}
      </div>
    );
  }

  return (
    <div>
      <div style={pageHeight}>
        <TableBody
          label={label}
          rows={slice}
          columns={columns}
          rowKey={rowKey}
          rowTone={rowTone}
          rowAttr="data-row"
          expandedRowKey={expandedRowKey}
          renderExpanded={renderExpanded}
          selection={selection}
        />
      </div>

      {(totalPages > 1 || fixed) && (
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
        className={`${FIELD} min-w-0 flex-1 basis-48`}
      />
      <div className={SEGMENTED_TRACK} role="group" aria-label="状态筛选">
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

/**
 * 分段控件的轨道与分段：筛选片（`aria-pressed`）与页内标签（tablist）共用同一外观。
 * 选中段是一块实色「滑块」+ 加粗，不只靠颜色；每段本身 44px（独立控件下限）。
 */
export const SEGMENTED_TRACK = "inline-flex flex-wrap gap-0.5 rounded-md bg-surface-active p-0.5 dark:bg-bg";

export function segmentClass(active: boolean): string {
  return `inline-flex min-h-[44px] items-center justify-center rounded-sm px-3 no-underline transition-colors ${
    active ? "bg-surface font-medium text-text shadow-thumb dark:bg-surface-active" : "text-text-muted hover:bg-surface-hover hover:text-text"
  }`;
}

/** 可切换的筛选片（分段控件里的一段）。选中态靠滑块 + 加粗 + `aria-pressed`，不只靠颜色。 */
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
      className={segmentClass(active)}
    >
      {label}
    </button>
  );
}

/**
 * 表格首次加载的骨架：列宽与行高与真实表格一致，数据到达时不跳动。
 *
 * 整块 `aria-hidden` —— 加载状态由调用方的文字（「检测中」「加载中」）报给读屏；
 * 骨架只是视觉占位。
 */
export function TableSkeleton({ columns, rows = 6 }: { columns: readonly string[]; rows?: number }) {
  return (
    <div aria-hidden="true" data-skeleton="table">
      <div className="flex border-b border-border-strong py-2 pl-3">
        {columns.map((w, i) => (
          <span key={i} className="pr-4" style={{ width: w }}>
            <Skeleton className="h-3 w-2/3" />
          </span>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center border-b border-border pl-3 last:border-0" style={{ height: `${ROW_HEIGHT}px` }}>
          {columns.map((w, i) => (
            <span key={i} className="pr-4" style={{ width: w }}>
              <Skeleton className="h-3.5 w-4/5" />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 选中若干行后出现在表格上方的批量操作条。「已选 N」+ 操作 + 取消选择；
 * 没有选中时不渲染，工具栏回到筛选。
 */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface-hover px-3 py-2"
    >
      <span className="font-medium">已选 {count} 项</span>
      <span className="flex flex-wrap gap-2">{children}</span>
      <span className="ml-auto">
        <SecondaryButton compact onClick={onClear}>
          取消选择
        </SecondaryButton>
      </span>
    </div>
  );
}

/**
 * 行内反馈（见 `lib/rowNotes.ts`）：图标 + 文字，可撤销时带「撤销」。放在行的状态列里，
 * 替代那一行的常规状态显示；失败的原因太长时截断，全文在 title。
 */
export function RowNoteView({
  note,
  onUndo,
  busy,
}: {
  note: { tone: "success" | "error"; text: string; undo?: unknown };
  onUndo: () => void;
  busy: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2" data-row-note={note.tone}>
      <span className={`inline-flex items-center gap-1.5 ${note.tone === "error" ? "text-error" : "text-success"}`}>
        <span aria-hidden="true">{note.tone === "error" ? "✕" : "✓"}</span>
        <Truncate text={note.text} maxWidth="16rem" />
      </span>
      {note.undo !== undefined && (
        <SecondaryButton compact disabled={busy} onClick={onUndo}>
          撤销
        </SecondaryButton>
      )}
    </span>
  );
}
