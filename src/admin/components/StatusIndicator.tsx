import { STATUS_ICON, type StatusIconName } from "./Icons.tsx";

/**
 * 状态指示器。
 *
 * 六个语义色里 accent-fg ↔ error 的色相只差约 14°,二色性模拟下四个状态会
 * 塌缩到 ≤1.28 的可分辨度(三色性下 1.01,即完全不可分)。调色解决不了这个
 * 问题 —— 任何满足 4.5:1 对比度的暖调配色都会落在同一片色相区间。
 * 所以颜色之外必须始终有第二(字形)与第三(文字)条信息通道。
 *
 * `icon` 与 `label` 都是必填,且运行期都会校验。
 *
 * `icon` 是 `STATUS_ICON` 里的名字,不是任意节点:先前传字符(✕ ✓ ! ○),各字体下字形
 * 大小与基线不一,与导航的 SVG 不协调。名字由类型限定;`label` 的空字符串类型挡不住
 * (`Exclude<string, "">` 仍是 `string`)。所以运行期再兜一道:空标签、不认识的图标名
 * (`as any` / 从 JS 调用)都直接抛错,不静默退化成只有颜色的状态。
 */

export type StatusTone = "success" | "warn" | "error" | "info" | "neutral";

export type StatusIndicatorProps = {
  tone: StatusTone;
  /** 必填:色觉障碍下颜色不可依赖,图形是第二条信息通道。 */
  icon: StatusIconName;
  /** 必填且不可为空:字形也可能被误读,文字标签是第三条通道,且屏幕阅读器只认它。 */
  label: string;
};

const TONE_CLASS: Record<StatusTone, string> = {
  success: "text-success",
  warn: "text-warn",
  error: "text-error",
  info: "text-info",
  neutral: "text-text-muted",
};

export function StatusIndicator({ tone, icon, label }: StatusIndicatorProps) {
  if (label.trim() === "") {
    throw new Error("StatusIndicator 的 label 不能为空:状态必须有文字标签");
  }
  // 只认自有键:`toString` 之类原型上的名字不是图标。
  if (typeof icon !== "string" || !Object.hasOwn(STATUS_ICON, icon)) {
    throw new Error("StatusIndicator 的 icon 不能为空:状态必须有图标,不能只靠颜色");
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${TONE_CLASS[tone]}`} data-tone={tone}>
      <span aria-hidden="true" className="inline-flex shrink-0" data-icon={icon}>
        {STATUS_ICON[icon]}
      </span>
      <span>{label}</span>
    </span>
  );
}
