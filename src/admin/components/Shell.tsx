import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Nav } from "./Nav.tsx";
import { SidebarIcon, SkinIcon, THEME_ICON } from "./Icons.tsx";
import { Truncate } from "./Panel.tsx";
import type { PageId } from "../lib/router.ts";
import { SIDEBAR_KEY, SKIN_OPTIONS, THEME_OPTIONS, nextPreference, useSkin, useTheme } from "../lib/theme.ts";

/**
 * 应用外壳：左侧栏 + 流式内容区。
 *
 * ## 同一份侧栏在两种宽度下复用
 *
 * 侧栏与窄屏顶栏是导航层，用毛玻璃（`zg-glass` / `zg-glass-thick`）；内容区是实色卡片。
 *
 * md 及以上侧栏常驻（展开 220px / 收起 64px 只剩图标，吸顶满高）；md 以下收成顶栏 +
 * 展开式抽屉。几种形态是**同一个 `<aside>`** 的不同样式，不渲染两份导航：两份会让
 * 「主导航」在无障碍树里出现两次，读屏用户听到重复条目，测试也无从判断哪一份是真的。
 *
 * ## 收起是显示偏好
 *
 * 与配色一样存 localStorage、不进 URL：分享链接不该改变对方的侧栏。收起时导航项只剩图标，
 * 可访问名称仍是完整文字（`aria-label` + `title` 悬停提示）。窄屏抽屉总是展开形态。
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
  task = null,
  children,
}: {
  current: PageId;
  badge: string | null;
  /** 网关版本；首次加载前未知时为 null。 */
  version: string | null;
  /** 正在后台进行的长任务（如出口探测）；在侧栏底部常驻，离开所在页面也看得到。 */
  task?: { label: string; href: string } | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useCollapsed();
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

  // 窄屏抽屉里总是展开形态：收起只对常驻侧栏有意义。
  const compact = collapsed && !open;

  return (
    <div className="min-h-screen md:flex">
      {/* 顶栏只在窄屏出现。 */}
      {/* 内容会从它下面滚过，所以用更不透明的厚玻璃（见 tokens.css 与对比度测试）。 */}
      <div className="zg-glass-thick sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border-strong px-4 py-2 md:hidden">
        <Wordmark />
        <button
          ref={toggleRef}
          type="button"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((v) => !v)}
          className="min-h-[44px] rounded-sm border border-border-strong bg-surface px-3 transition-colors hover:bg-surface-hover active:bg-surface-active"
        >
          {open ? "收起菜单" : "菜单"}
        </button>
      </div>

      <aside
        ref={asideRef}
        id={drawerId}
        data-open={open ? "" : undefined}
        data-collapsed={compact ? "" : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            close(true);
          }
        }}
        /* 侧栏是导航层：毛玻璃，背后只有固定的背景色场。 */
        className={`zg-glass ${open ? "flex" : "hidden"} flex-col border-b border-border-strong md:sticky md:top-0 md:flex md:h-screen md:shrink-0 md:border-b-0 md:border-r ${
          compact ? "md:w-16" : "md:w-[220px]"
        }`}
      >
        {/* 品牌行与导航项同一套左右内边距，图标列与文字列上下对齐。 */}
        {/* 品牌行的左内边距 = 导航列表 px-2 + 导航项 px-3，wordmark 与导航图标左对齐。 */}
        <div className={`hidden h-16 items-center md:flex ${compact ? "justify-center" : "px-5"}`}>
          {compact ? <Monogram /> : <Wordmark />}
        </div>
        <div className="py-2 md:flex-1 md:overflow-y-auto">
          <Nav current={current} badge={badge} collapsed={compact} onNavigate={() => close(false)} />
        </div>
        {task !== null && (
          <a
            href={task.href}
            role="status"
            title={task.label}
            aria-label={task.label}
            className={`mx-2 mb-2 flex min-h-[44px] items-center gap-2 rounded-md bg-surface px-3 text-info no-underline dark:bg-surface-active ${
              compact ? "justify-center px-0" : ""
            }`}
          >
            <span aria-hidden="true">◴</span>
            {!compact && <Truncate text={task.label} maxWidth="10rem" />}
          </a>
        )}
        <div
          className={`flex gap-1 border-t border-border-strong py-3 ${
            compact ? "flex-col items-center px-2" : "items-center px-3"
          }`}
        >
          <ThemeButton />
          <SkinButton />
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            aria-pressed={collapsed}
            className={`${iconButton} hidden md:inline-flex`}
          >
            <SidebarIcon collapsed={collapsed} />
          </button>
          {version !== null && !compact && (
            <span className="ml-auto pr-2 text-label-12 text-text-muted">v{version}</span>
          )}
        </div>
      </aside>

      {/* 内容区流式铺满剩余宽度；长段落在面板内自行限行长。 */}
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}

/** 侧栏底部的图标按钮：44px 正方形命中区。 */
const iconButton =
  "inline-flex h-11 w-11 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text active:bg-surface-active";

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setState] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    try {
      if (next) window.localStorage.setItem(SIDEBAR_KEY, "collapsed");
      else window.localStorage.removeItem(SIDEBAR_KEY);
    } catch {
      // 写不进去时本次会话仍然生效。
    }
    setState(next);
  };
  return [collapsed, set];
}

function Wordmark() {
  // wordmark 是衬线真能生效的地方之一（纯拉丁）。
  return <p className="font-serif text-heading-20 tracking-tight">zen-gateway</p>;
}

function Monogram() {
  return (
    <p className="font-serif text-heading-20" aria-label="zen-gateway">
      zg
    </p>
  );
}

/**
 * 主题切换：一个图标按钮，在跟随系统 / 浅色 / 深色之间循环。图标显示当前偏好，
 * 可访问名称说出当前值与下一步，读屏用户不用猜点了会怎样。
 */
function ThemeButton() {
  const { preference, setPreference } = useTheme();
  const label = (p: typeof preference) => THEME_OPTIONS.find((o) => o.value === p)?.label ?? p;
  const next = nextPreference(preference);
  const text = `配色：${label(preference)}，点击切换为${label(next)}`;
  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      aria-label={text}
      title={text}
      data-theme-preference={preference}
      className={iconButton}
    >
      {THEME_ICON[preference]}
    </button>
  );
}

/** 换皮肤：在冷灰蓝与暖米白之间切换。与配色按钮一样，名称说出当前值与下一步。 */
function SkinButton() {
  const { skin, setSkin } = useSkin();
  const next = skin === "cool" ? "warm" : "cool";
  const label = (v: typeof skin) => SKIN_OPTIONS.find((o) => o.value === v)?.label ?? v;
  const text = `皮肤：${label(skin)}，点击切换为${label(next)}`;
  return (
    <button type="button" onClick={() => setSkin(next)} aria-label={text} title={text} data-skin-value={skin} className={iconButton}>
      <SkinIcon />
    </button>
  );
}
