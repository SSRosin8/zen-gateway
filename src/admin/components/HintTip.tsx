import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * 说明提示：一个 ⓘ 按钮，悬停、键盘聚焦或点击时在旁边浮出说明，移开或 Esc 收起。
 *
 * 用来收纳「知道了就不必一直看」的规则说明，让页面把位置留给数据。只放补充说明：
 * 用户必须看到才能操作的信息（错误、空状态的下一步、确认框里的后果）仍直接写在页面上。
 *
 * 浮层是 `role="tooltip"` 并由按钮 `aria-describedby` 引用，读屏在聚焦按钮时读出内容。
 * 用 fixed 定位贴在按钮下方，靠近视口右缘时向左收，避免被面板的 overflow 裁掉；
 * 打开期间随滚动与窗口缩放重算位置。
 */
export function HintTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // 点击固定住：悬停移开不收起，再点一次或 Esc 才收。触屏上没有悬停，只能靠点击。
  const [pinned, setPinned] = useState(false);

  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (r === undefined) return;
    const width = 320;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  };
  const hide = () => {
    setPinned(false);
    setPos(null);
  };

  // 打开期间跟随按钮：fixed 定位是按显示那一刻算的，页面或面板滚动、窗口缩放后要重算。
  const open = pos !== null;
  useEffect(() => {
    if (!open) return;
    const follow = () => show();
    // 捕获阶段：滚动的可能是任何一层容器，而 scroll 事件不冒泡。
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <span className="relative inline-flex align-middle">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-describedby={pos === null ? undefined : id}
        aria-expanded={pos !== null}
        onMouseEnter={show}
        onMouseLeave={() => {
          if (!pinned) setPos(null);
        }}
        onFocus={show}
        onBlur={hide}
        onClick={() => {
          if (pinned) hide();
          else {
            setPinned(true);
            show();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") hide();
        }}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full text-label-13 text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {pos !== null && (
        <span
          id={id}
          role="tooltip"
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-50 block w-80 max-w-[calc(100vw-1rem)] rounded-md border border-border-strong bg-surface p-3 text-left text-copy-14 font-normal text-text shadow-float"
        >
          {children}
        </span>
      )}
    </span>
  );
}
