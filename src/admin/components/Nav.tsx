import { PAGES, PAGE_LABEL, toHash, parseHash, type PageId } from "../lib/router.ts";
import { PAGE_ICON } from "./Icons.tsx";

/**
 * 侧栏导航。
 *
 * 条目从 `PAGES` 推导 —— 那份清单是路由分派的同一个真相。手写一份会分叉
 * （纪律 #4），而分叉方向是「导航上有的页面路由不认识」或反之。
 *
 * 条目是真实的 `<a href="#page">`：中键、新标签页打开、复制链接都能用。
 * 点击只改 hash，由 `useViewState` 的 hashchange 订阅切换页面。
 *
 * 选中态用 **3px 左边框实色 + 文字换 accent-fg**，不用 `accent-fill` 做底：
 * 那个 token 只有 `on-accent-fill` 一个合格前景（5.90），整条导航项铺满它
 * 会让徽标等次要文字不可读。
 *
 * `badge` 只挂在快速开始上（首启未完成时的进度），完成后不再显示。
 *
 * 每项是「图标 + 文字 + 可选徽标」三列，固定 12px 间距与左右内边距，所有项的图标与文字
 * 各自对齐成一列。收起时只剩图标并居中，名称给 `aria-label` 与 `title`；徽标退成一个圆点。
 */
export function Nav({
  current,
  badge,
  onNavigate,
  collapsed = false,
}: {
  current: PageId;
  /** 快速开始的进度文字，如「2/3」；null = 已完成，不显示。 */
  badge?: string | null;
  /** 点击任一链接后调用（移动端用来收起抽屉）。 */
  onNavigate?: () => void;
  /** 侧栏收起：只显示图标。 */
  collapsed?: boolean;
}) {
  return (
    <nav aria-label="主导航">
      <ul className="flex flex-col gap-0.5">
        {PAGES.map((page) => {
          const active = page === current;
          const showBadge = page === "start" && badge !== undefined && badge !== null;
          return (
            <li key={page}>
              <a
                href={toHash({ ...parseHash(""), page })}
                onClick={onNavigate}
                /* 触摸目标 ≥44px。左边框常驻（透明），选中时只换色，文字不跳位。 */
                className={`relative flex min-h-[44px] items-center gap-3 border-l-[3px] no-underline transition-colors hover:bg-surface-hover active:bg-surface-active ${
                  collapsed ? "justify-center px-0" : "pl-[17px] pr-4"
                } ${
                  active
                    ? "border-l-accent-fg font-medium text-accent-fg"
                    : "border-l-transparent text-text-muted hover:text-text"
                }`}
                /* 屏幕阅读器要知道哪个是当前页 —— 颜色与边框它读不到。 */
                aria-current={active ? "page" : undefined}
                {...(collapsed ? { "aria-label": PAGE_LABEL[page], title: PAGE_LABEL[page] } : {})}
              >
                {PAGE_ICON[page]}
                {!collapsed && <span className="flex-1">{PAGE_LABEL[page]}</span>}
                {showBadge &&
                  (collapsed ? (
                    <span
                      className="absolute right-3 top-2.5 h-2 w-2 rounded-full bg-accent-fg"
                      aria-label={`首启进度 ${badge}`}
                      data-onboarding-badge=""
                    />
                  ) : (
                    <span
                      className="rounded-xs border border-border-strong bg-bg px-1.5 text-label-12 text-text"
                      aria-label={`首启进度 ${badge}`}
                      data-onboarding-badge=""
                    >
                      {badge}
                    </span>
                  ))}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
