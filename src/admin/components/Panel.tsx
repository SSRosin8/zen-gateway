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
 * 每页 ≤1 个主操作（交互规则）。
 *
 * ## 禁用态:降**底色**的饱和度，不降整体透明度
 *
 * 目标是「看得出不能点，但读得清为什么」—— 一个读不清的禁用按钮
 * 无法告诉用户它在等什么（这里的禁用文案正是「进行中…」「探测中…」）。
 *
 * 先前用 `disabled:opacity-60`，而那**同时**淡化底色与文字:实测文字对比度
 * 从 5.90 掉到 **2.51**（浅色）/ 2.91（深色），远低于 4.5 —— 也就是说
 * 注释写着「保留文字对比度」，而实现恰好把它破坏掉了（第八轮审核实测）。
 *
 * 现在改成:底色换成一个更淡的实色（`accent-fill/40` 那种效果由
 * `disabled:bg-border-strong` 给出），文字保持 `text-text` 不透明。
 * 「不可点」由 `cursor-not-allowed` 与明显变淡的底色表达。
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
      /*
       * 触摸目标 ≥44px（移动端无障碍要求）。
       *
       * 禁用态换底色而不是降透明度 —— 见上文。实测 `text` 压在 `border-strong`
       * 上是 11.80（浅）/ 7.94（深），而原先的 `opacity-60` 只有 2.51 / 2.91。
       */
      className="min-h-[44px] rounded-sm bg-accent-fill px-4 font-medium text-on-accent-fill disabled:cursor-not-allowed disabled:bg-border-strong disabled:text-text"
    >
      {children}
    </button>
  );
}

/**
 * 表格行的状态标记 —— **3px 左边框实色，不用背景色块**。
 *
 * 实测理由（2026-09-25 第八轮重测）：警告色在必要的 25% alpha 下相对
 * `surface-accent` 只有 **1.41**（浅色）/ **1.76**（深色）对比度 ——
 * 肉眼与无状态行几乎无差别，等于没画。换成实色左边框是 **5.29 / 7.96**，可靠。
 *
 * > 这里先前写的是「1.006」。第八轮按各种口径都算不出那个数(最接近的组合是
 * > 另一种前景/底色配对),所以那是一个抄错位置的数字 —— **结论没变,依据修正**。
 * > 教训按纪律 #6:注释里的实测数字要能被重算出来,否则它只是看起来像证据。
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

/**
 * 强调。
 *
 * ## 为什么需要一个组件而不是写 `**...**`
 *
 * JSX 不渲染 markdown,所以文案里的 `**同一时刻只允许一批**` 会**原样**带着
 * 星号显示给用户。第八轮审核实测:六个页面全中,共十余处,而且集中在
 * 最要紧的那些警告上（GLOBAL 分组陷阱、mixed-port 陷阱、免 key 通道已关闭、
 * 「只能用真实 CLI」）—— 也就是说最需要被看清的句子显示得最糟。
 *
 * 成因是这些文案都从文档/注释里搬过来的,那里 `**` 是对的。既有测试用
 * `/不要写/`、`/GLOBAL/` 这类正则匹配,**正好跳过了星号**,所以没人发现。
 *
 * 用 `font-medium` 而不是 `<strong>` 的默认粗体:正文 14px 下
 * `font-bold` 在这套字体里偏重,会让一段话里出现视觉断层。
 * 语义上仍用 `<strong>` —— 屏幕阅读器该知道这是强调。
 */
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-medium">{children}</strong>;
}
