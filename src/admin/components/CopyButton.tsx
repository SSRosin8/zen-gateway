import { useCopy } from "../lib/clipboard.ts";
import { SecondaryButton } from "./Panel.tsx";

/** 复制按钮：成功短暂显示「已复制」，失败提示手动选中（复制逻辑与退路见 `lib/clipboard.ts`）。 */
export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const { state, copy } = useCopy();
  return <SecondaryButton onClick={() => copy(text)}>{state === "copied" ? "已复制" : state === "failed" ? "复制失败，请手动选中" : label}</SecondaryButton>;
}
