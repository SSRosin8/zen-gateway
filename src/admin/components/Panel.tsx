import type { ReactNode } from "react";
import { StatusIndicator } from "./StatusIndicator.tsx";

/**
 * 面板 —— 层次靠「表面色调 + 1px 边框」，**不用 box-shadow**。因此边框必须
 * 真的可见：`border` 在 `surface` 上只有 1.077 对比度，所以卡片叠在面板上时
 * 一律用 `border-strong`（1.34）。禁用 shadow 后层次只剩色调与边框两个机制，
 * 其中边框在 surface 上不可见的话，就没有任何手段表达层次。
 */
export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border-strong bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong px-4 py-3 sm:px-5">
        <h2 className="text-heading-16 font-medium">{title}</h2>
        {action}
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

/**
 * 指标卡。
 *
 * 大号数字用 `font-serif` —— 这是衬线**真能生效**的少数位置之一：
 * Instrument Serif 的 CJK 覆盖为零，所以标题归 Inter，衬线只留给
 * 拉丁数字、向导、空状态、wordmark。
 *
 * `tabular-nums` 让数字逐位可比（一个 3 位数变成 2 位时不会让整行跳动）。
 */
export function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "normal" | "warn" | "error";
}) {
  const valueClass =
    tone === "error" ? "text-error" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div>
      <div className="text-label-14 text-text-muted">{label}</div>
      <div
        className={`mt-1 font-serif text-display-30 ${valueClass}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      {hint !== undefined && <div className="mt-1 text-label-13 text-text-muted">{hint}</div>}
    </div>
  );
}

/**
 * 主操作按钮。每个视图最多一个；其余操作用 `SecondaryButton`。
 *
 * `accent-fill` 做底 + `on-accent-fill` 做字 —— 那是它**唯一**合格的前景
 * （5.90）。其余前景压在它上面全部不及格（`text-muted` 2.22、
 * `accent-fg` 1.92），所以 `accent-fill` 只能用在这种「只承载主文案的紧凑
 * 元素」上，**绝不能做整行背景**（行内的时间/延迟/备注会不可读）。
 *
 * ## 禁用态换实色，不降透明度
 *
 * 目标是「看得出不能点，但读得清为什么」—— 这里的禁用文案正是「进行中…」
 * 「探测中…」。`disabled:opacity-60` 会同时淡化底色与文字，文字对比度从 5.90
 * 掉到 2.51（浅色）/ 2.91（深色）。所以底色换成 `border-strong`，文字保持
 * `text`（11.80 / 7.94），「不可点」由 `cursor-not-allowed` 与变淡的底色表达。
 *
 * 悬停/按下只挂在 `enabled:` 上：禁用按钮不该对指针有反馈。
 */
export function PrimaryButton({
  onClick,
  disabled,
  type = "button",
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      /* 触摸目标 ≥44px。 */
      className="min-h-[44px] rounded-sm bg-accent-fill px-4 font-medium text-on-accent-fill transition-colors enabled:hover:bg-accent-fill-hover enabled:active:bg-accent-fill-hover disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-text"
    >
      {children}
    </button>
  );
}

/**
 * 描边按钮 —— 次操作、取消、编辑、翻页共用。
 *
 * `danger` 用 error 描边与文字表达破坏性操作；图形之外还靠按钮文案本身
 * （「删除」「确认删除」）表达，不只靠颜色。禁用态同样换实色：边框降到
 * `border`、文字降到 `text-muted`，两者在 surface/bg 上仍 ≥4.5（见
 * `tests/design/contrast.test.ts` 的禁用态断言）。
 *
 * `compact` 只用于表格行内（行高 36px 装不下 44px 按钮）：高 32px，仍高于
 * WCAG 2.2 AA 2.5.8 的 24px 下限。独立控件一律保持 44px。
 */
export function SecondaryButton({
  onClick,
  disabled,
  type = "button",
  danger = false,
  compact = false,
  buttonRef,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
  danger?: boolean;
  compact?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-sm border transition-colors enabled:hover:bg-surface-hover enabled:active:bg-surface-active disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted ${
        compact ? "min-h-8 px-2.5" : "min-h-[44px] px-3"
      } ${danger ? "border-error text-error" : "border-border-strong"}`}
    >
      {children}
    </button>
  );
}

/**
 * 表单保存结果。
 *
 * 成功与失败用不同色调 + 图标 + 文字（`StatusIndicator`），不靠颜色区分。
 * 外层 `aria-live="polite"` 始终挂着 —— 播报依赖区域先存在、内容后变化，
 * 条件渲染整个区域的话屏幕阅读器可能不念。错误额外包一层 `role="alert"`。
 */
export type FormMessage = { readonly tone: "success" | "error"; readonly text: string } | null;

export function FormStatus({ message }: { message: FormMessage }) {
  return (
    <div aria-live="polite" className="min-w-0">
      {message !== null &&
        (message.tone === "error" ? (
          <div role="alert">
            <StatusIndicator tone="error" icon="✕" label={message.text} />
          </div>
        ) : (
          <StatusIndicator tone="success" icon="✓" label={message.text} />
        ))}
    </div>
  );
}

/** 把任意抛出值变成错误提示。 */
export function errorMessage(err: unknown): FormMessage {
  return { tone: "error", text: err instanceof Error ? err.message : String(err) };
}

/**
 * 表格行的状态标记 —— **3px 左边框实色，不用背景色块**。
 *
 * 警告色在必要的 25% alpha 下相对 `surface-accent` 只有 **1.41**（浅色）/
 * **1.76**（深色）对比度，肉眼与无状态行几乎无差别。实色左边框是 **5.29 / 7.96**。
 */
export function RowMark({ tone }: { tone: "success" | "warn" | "error" | "neutral" }) {
  const color = {
    success: "border-l-success",
    warn: "border-l-warn",
    error: "border-l-error",
    neutral: "border-l-border-strong",
  }[tone];
  return <span className={`absolute inset-y-0 left-0 border-l-[3px] ${color}`} aria-hidden="true" />;
}

/**
 * 等宽显示的技术标识（id / IP / 端口 / 模型名 / 指纹）。
 *
 * 这些值要逐字符比对，而比例字体下 `l`/`1`/`I` 与 `0`/`O` 难分辨。
 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

/**
 * 单行截断。被截掉的部分必须能找回：`title` 给指针用户悬停看全文；
 * 文本节点本身完整留在 DOM 里，屏幕阅读器读的就是全文，所以不另加 aria-label。
 */
export function Truncate({ text, maxWidth, className = "" }: { text: string; maxWidth: string; className?: string }) {
  return (
    <span className={`inline-block truncate align-bottom ${className}`} style={{ maxWidth }} title={text}>
      {text}
    </span>
  );
}

/**
 * 骨架块 —— 首次加载时占住最终布局的位置，避免数据到达时整页跳动。
 *
 * 实色 `surface-accent`，没有扫光动画；只有一次延迟淡入（`zg-skeleton`，见 index.css），
 * 本机请求通常几十毫秒就回来，延迟让它们根本不出现骨架。
 */
export function Skeleton({ className }: { className: string }) {
  return <span aria-hidden="true" className={`zg-skeleton block rounded-xs bg-surface-accent ${className}`} />;
}

/**
 * 强调。
 *
 * JSX 不渲染 markdown，文案里的 `**同一时刻只允许一批**` 会原样带着星号显示。
 * 用 `<strong>` 保留语义，`font-medium` 而不是默认粗体：正文 14px 下
 * `font-bold` 在这套字体里偏重，会让一段话里出现视觉断层。
 */
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-medium">{children}</strong>;
}
