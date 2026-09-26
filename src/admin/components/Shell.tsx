import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Nav } from "./Nav.tsx";
import type { PageId } from "../lib/router.ts";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "../lib/theme.ts";

/**
 * 应用外壳：左侧栏 + 流式内容区。
 *
 * ## 同一份侧栏在两种宽度下复用
 *
 * md 及以上侧栏常驻（220px，吸顶满高）；md 以下收成顶栏 + 展开式抽屉。
 * 两种形态是**同一个 `<aside>`** 的不同样式，不渲染两份导航：两份会让
 * 「主导航」「配色」在无障碍树里各出现两次，读屏用户听到重复条目，
 * 测试也无从判断哪一份是真的。
 *
 * ## 抽屉是展开区（disclosure），不是模态
 *
 * 它推开内容而不是盖住内容，所以不需要焦点圈定；打开时焦点移到第一个导航项，
 * Esc 关闭并把焦点还给菜单按钮，点任一导航项后自动收起。
 */
export function Shell({
  current,
  badge,
  version,
  children,
}: {
  current: PageId;
  badge: string | null;
  /** 网关版本；首次加载前未知时为 null。 */
  version: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    asideRef.current?.querySelector<HTMLAnchorElement>("nav a")?.focus();
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  };

  return (
    <div className="min-h-screen md:flex">
      {/* 顶栏只在窄屏出现。 */}
      <div className="flex items-center justify-between gap-3 border-b border-border-strong bg-surface px-4 py-2 md:hidden">
        <Brand compact />
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((v) => !v)}
          className="min-h-[44px] rounded-sm border border-border-strong px-3 transition-colors hover:bg-surface-hover active:bg-surface-active"
        >
          {open ? "收起菜单" : "菜单"}
        </button>
      </div>

      <aside
        ref={asideRef}
        id={drawerId}
        data-open={open ? "" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close(true);
          }
        }}
        className={`${open ? "flex" : "hidden"} flex-col border-b border-border-strong bg-surface md:sticky md:top-0 md:flex md:h-screen md:w-[220px] md:shrink-0 md:border-b-0 md:border-r`}
      >
        <div className="hidden px-4 pb-4 pt-6 md:block">
          <Brand />
        </div>
        <div className="py-2 md:flex-1 md:overflow-y-auto">
          <Nav current={current} badge={badge} onNavigate={() => close(false)} />
        </div>
        <div className="space-y-2 border-t border-border-strong px-4 py-4">
          <ThemeSelect />
          {version !== null && <p className="text-label-12 text-text-muted">zen-gateway v{version}</p>}
        </div>
      </aside>

      {/* 内容区流式铺满剩余宽度；长段落在面板内自行限行长。 */}
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div>
      {/* wordmark 是衬线真能生效的地方之一（纯拉丁）。 */}
      <p className={`font-serif tracking-tight ${compact ? "text-heading-20" : "text-display-30"}`}>zen-gateway</p>
      {!compact && <p className="mt-2 text-label-12 text-text-muted">OpenCode Zen 免费模型本地网关</p>}
    </div>
  );
}

function ThemeSelect() {
  const { preference, setPreference } = useTheme();
  return (
    <label className="flex items-center justify-between gap-2 text-text-muted">
      <span>配色</span>
      <select
        value={preference}
        onChange={(e) => setPreference(e.target.value as ThemePreference)}
        className="min-h-[44px] rounded-sm border border-border-strong bg-bg px-3 text-text"
      >
        {THEME_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
