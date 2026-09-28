import { useState, type ReactNode } from "react";
import { Nav } from "./Nav.tsx";
import { SidebarIcon, SkinIcon, THEME_ICON } from "./Icons.tsx";
import { Truncate } from "./Panel.tsx";
import type { PageId } from "../lib/router.ts";
import { SIDEBAR_KEY, SKIN_OPTIONS, THEME_OPTIONS, nextPreference, useSkin, useTheme } from "../lib/theme.ts";

/**
 * 应用外壳：左侧栏 + 流式内容区。
 *
 * 只面向桌面浏览器，不做手机布局。侧栏常驻（展开 220px / 收起 64px 只剩图标，吸顶满高），
 * 是导航层，用毛玻璃（`zg-glass`）；内容区是实色卡片。
 *
 * ## 收起是显示偏好
 *
 * 与配色一样存 localStorage、不进 URL：分享链接不该改变对方的侧栏。收起时导航项只剩图标，
 * 可访问名称仍是完整文字（`aria-label` + `title` 悬停提示）。
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
  const [collapsed, setCollapsed] = useCollapsed();

  return (
    <div className="flex min-h-screen">
      <aside
        data-collapsed={collapsed ? "" : undefined}
        /* 侧栏是导航层：毛玻璃，背后只有固定的背景色场。 */
        className={`zg-glass sticky top-0 flex h-screen shrink-0 flex-col border-r border-border-strong ${
          collapsed ? "w-16" : "w-[220px]"
        }`}
      >
        {/* 品牌行的左内边距 = 导航列表 px-2 + 导航项 px-3，wordmark 与导航图标左对齐。 */}
        <div className={`flex h-16 items-center ${collapsed ? "justify-center" : "px-5"}`}>
          {collapsed ? <Monogram /> : <Wordmark />}
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          <Nav current={current} badge={badge} collapsed={collapsed} />
        </div>
        {task !== null && (
          <a
            href={task.href}
            role="status"
            title={task.label}
            aria-label={task.label}
            className={`mx-2 mb-2 flex min-h-[44px] items-center gap-2 rounded-md bg-surface px-3 text-info no-underline dark:bg-surface-active ${
              collapsed ? "justify-center px-0" : ""
            }`}
          >
            <span aria-hidden="true">◴</span>
            {!collapsed && <Truncate text={task.label} maxWidth="10rem" />}
          </a>
        )}
        <div
          className={`flex gap-1 border-t border-border-strong py-3 ${
            collapsed ? "flex-col items-center px-2" : "items-center px-3"
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
            className={iconButton}
          >
            <SidebarIcon collapsed={collapsed} />
          </button>
          {version !== null && !collapsed && (
            <span className="ml-auto pr-2 text-label-12 text-text-muted">v{version}</span>
          )}
        </div>
      </aside>

      {/* 内容区流式铺满剩余宽度；长段落在面板内自行限行长。 */}
      <main className="min-w-0 flex-1 px-6 py-6 lg:px-8 lg:py-8">{children}</main>
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
