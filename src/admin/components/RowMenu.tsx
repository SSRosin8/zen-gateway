import { useId, useRef } from "react";

/**
 * 行的「更多」菜单。行内最多放两个常用按钮，其余进这里。
 *
 * 用原生 `popover` 属性：浏览器负责置顶层、点外面关闭与 Esc 关闭，不引弹层库。
 * 打开时焦点进第一项，选中或 Esc 后焦点回到触发按钮。
 * 不可用的项仍然列出并说明原因（`disabledReason`），而不是悄悄消失。
 */
export type RowMenuItem = {
  readonly label: string;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabledReason?: string | null;
};

export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = () => {
    menu.current?.hidePopover?.();
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        popoverTarget={id}
        className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-xs border border-border-strong bg-surface text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:bg-surface-active"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onToggle={(e) => {
          if ((e as unknown as { newState?: string }).newState !== "open") return;
          // 贴在触发按钮下方右对齐；靠近视口底部时翻到上方。popover 在顶层，用视口坐标。
          const t = trigger.current?.getBoundingClientRect();
          const m = menu.current;
          if (t !== undefined && m !== null) {
            const h = m.offsetHeight;
            const top = t.bottom + 4 + h > window.innerHeight ? t.top - 4 - h : t.bottom + 4;
            m.style.top = `${Math.max(4, top)}px`;
            m.style.left = `${Math.max(4, t.right - m.offsetWidth)}px`;
          }
          m?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        style={{ position: "fixed", inset: "auto" }}
        className="m-0 min-w-40 rounded-md border border-border-strong bg-surface p-1 text-text shadow-float"
      >
        {items.map((item) => {
          const disabled = item.disabledReason !== undefined && item.disabledReason !== null;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={disabled}
              title={disabled ? (item.disabledReason ?? undefined) : undefined}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className={`flex min-h-9 w-full items-center rounded-xs px-3 text-left transition-colors enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-text-muted ${
                item.danger === true ? "enabled:text-error" : ""
              }`}
            >
              {item.label}
              {disabled && <span className="sr-only">（{item.disabledReason}）</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
