import type { ReactNode } from "react";

/**
 * 面板 —— 层次靠「表面色调 + 1px 边框」，**不用 box-shadow**（Anthropic 体系
 * 的明确规则）。因此边框必须真的可见：`border` 在 `surface` 上只有 1.077
 * 对比度，所以卡片叠在面板上时一律用 `border-strong`（1.34）。
 * 那个 token 正是为这个缺口新增的 —— 禁用 shadow 后层次只剩两个机制，
 * 而其中一个（边框）在 surface 上等于不存在的话，就没有任何手段表达层次。
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
    <section className="rounded-lg border border-border-strong bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border-strong px-5 py-3">
        <h2 className="text-base font-medium">{title}</h2>
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/**
 * 指标卡。
 *
 * 大号数字用 `font-serif` —— 这是衬线**真能生效**的少数位置之一：
 * Instrument Serif 的 CJK 覆盖为零，所以标题归 Inter，衬线只留给
 * 拉丁数字、向导、空状态、wordmark。这里是纯数字。
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
      <div className="text-text-muted">{label}</div>
      <div
        className={`mt-1 font-serif text-3xl leading-none ${valueClass}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      {hint !== undefined && <div className="mt-1 text-text-muted">{hint}</div>}
    </div>
  );
}

/**
 * 主操作按钮。
 *
 * `accent-fill` 做底 + `on-accent-fill` 做字 —— 那是它**唯一**合格的前景
 * （5.90）。其余前景压在它上面全部不及格（`text-muted` 2.22、
 * `accent-fg` 1.92），所以 `accent-fill` 只能用在这种「只承载主文案的紧凑
 * 元素」上，**绝不能做整行背景**（行内的时间/延迟/备注会不可读）。
 *
 * 每页 ≤1 个主操作（交互规则）。禁用态降透明度并给 `cursor-not-allowed`,
 * 同时**保留文字对比度** —— 一个读不清的禁用按钮无法告诉用户它为什么禁用。
 */
export function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      /* 触摸目标 ≥44px（移动端无障碍要求）。 */
      className="min-h-[44px] rounded-sm bg-accent-fill px-4 font-medium text-on-accent-fill disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/**
 * 表格行的状态标记 —— **3px 左边框实色，不用背景色块**。
 *
 * 实测理由：警告色在必要的 25% alpha 下相对 `surface-accent` 只有 1.006
 * 对比度 —— 肉眼与无状态行无差别，等于没画。左边框用实色，可靠。
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
 * 这些值要逐字符比对（「我填的 key 是不是这个」），而比例字体下
 * `l`/`1`/`I` 与 `0`/`O` 难分辨。
 */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}
