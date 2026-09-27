import { useState } from "react";

/**
 * 复制文字到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS 或 localhost）里存在。从局域网用
 * `http://<IP>:5173` 打开后台时它是 `undefined`，`navigator.clipboard?.writeText()`
 * 什么都不做也不报错，按钮看起来「没反应」。所以没有它或它拒绝时退回
 * `document.execCommand("copy")`（已废弃但在非安全上下文里仍是唯一可用的办法），
 * 两条路都失败才返回 false，由调用方明确告诉用户去手动复制。
 */
export async function copyText(text: string): Promise<boolean> {
  // 非安全上下文里浏览器根本不暴露 `navigator.clipboard`，所以只判它在不在。
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒等：继续尝试退路。
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // 放在视口外，不引起滚动与闪烁。
  area.style.position = "fixed";
  area.style.top = "-1000px";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  // 先聚焦再选中：部分浏览器只复制获得焦点的选区。
  const focused = document.activeElement as HTMLElement | null;
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    area.remove();
    focused?.focus();
    if (previous !== null && selection !== null) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
  return ok;
}

/** 复制按钮的状态：成功时短暂显示「已复制」，失败时显示「复制失败」并保持到下次点击。 */
export function useCopy(): { state: "idle" | "copied" | "failed"; copy: (text: string) => void } {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return {
    state,
    copy: (text) => {
      void copyText(text).then((ok) => {
        setState(ok ? "copied" : "failed");
        if (ok) window.setTimeout(() => setState("idle"), 1500);
      });
    },
  };
}
