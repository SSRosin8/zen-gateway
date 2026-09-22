import type { ReactNode } from "react";

/**
 * 状态指示器。
 *
 * 六个语义色里 accent-fg ↔ error 的色相只差约 14°,二色性模拟下四个状态会
 * 塌缩到 ≤1.28 的可分辨度(三色性下 1.01,即完全不可分)。调色解决不了这个
 * 问题 —— 任何满足 4.5:1 对比度的暖调配色都会落在同一片色相区间。
 * 所以颜色之外必须始终有第二(字形)与第三(文字)条信息通道。
 *
 * `icon` 与 `label` 都是必填,且运行期都会校验非空。
 *
 * **分工要说清,免得再次高估类型的能力**:
 *   - 类型挡住 `null` / `undefined` / `false`(已实测确认这三个会报错)
 *   - 类型**挡不住空字符串**:`Exclude<string, "">` 仍然是 `string` ——
 *     TypeScript 无法从宽泛的原始类型里减去一个字面量。
 *   - 所以 `""`、`"   "`、`[]` 只能由下面的运行期守卫拦住。
 *
 * 两道都要:类型挡住最常见的手滑(忘传、传了个可能为 null 的变量),
 * 运行期挡住类型表达不了的空值形态与绕过类型的调用(`as any` / 从 JS 调用)。
 */

export type StatusTone = "success" | "warn" | "error" | "info" | "neutral";

/** 排除 ReactNode 里能被类型表达的空值形态(空字符串由运行期守卫拦)。 */
export type NonEmptyIcon = Exclude<ReactNode, null | undefined | boolean>;

export type StatusIndicatorProps = {
  tone: StatusTone;
  /** 必填且不可为空:色觉障碍下颜色不可依赖,字形是第二条信息通道。 */
  icon: NonEmptyIcon;
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

/** 空图标的判定:类型之外再兜一道,覆盖 as any 与从 JS 调用的情形。 */
function isEmptyIcon(icon: unknown): boolean {
  return (
    icon === null ||
    icon === undefined ||
    typeof icon === "boolean" ||
    (typeof icon === "string" && icon.trim() === "") ||
    (Array.isArray(icon) && icon.length === 0)
  );
}

export function StatusIndicator({ tone, icon, label }: StatusIndicatorProps) {
  if (label.trim() === "") {
    throw new Error("StatusIndicator 的 label 不能为空:状态必须有文字标签");
  }
  if (isEmptyIcon(icon)) {
    throw new Error("StatusIndicator 的 icon 不能为空:状态必须有图标,不能只靠颜色");
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
