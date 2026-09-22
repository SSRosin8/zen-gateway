import type { ReactNode } from "react";

/**
 * 状态指示器。
 *
 * 六个语义色里 accent-fg ↔ error 的色相只差约 14°,二色性模拟下四个状态会
 * 塌缩到 ≤1.28 的可分辨度(三色性下 1.01,即完全不可分)。调色解决不了这个
 * 问题 —— 任何满足 4.5:1 对比度的暖调配色都会落在同一片色相区间。
 *
 * 所以 `icon` 与 `label` 都是必填 prop:类型上就不存在「只给颜色」的调用形态。
 * 这不是约定,是编译器强制。
 */

export type StatusTone = "success" | "warn" | "error" | "info" | "neutral";

export type StatusIndicatorProps = {
  tone: StatusTone;
  /** 必填:色觉障碍下颜色不可依赖,字形是第二条信息通道。 */
  icon: ReactNode;
  /** 必填:字形也可能被误读,文字标签是第三条通道,且屏幕阅读器只认它。 */
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
  // 类型挡住了「不传 label」,挡不住「传空串」—— 后者同样退回到只有颜色。
  // 空标签是调用方的 bug,直接抛而不是静默渲染一个无名状态。
  if (label.trim() === "") {
    throw new Error("StatusIndicator 的 label 不能为空:状态必须有文字标签");
  }

  return (
    <span className={`inline-flex items-center gap-1.5 ${TONE_CLASS[tone]}`} data-tone={tone}>
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      <span>{label}</span>
    </span>
  );
}
