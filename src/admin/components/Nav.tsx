import { NAV_GROUPS, PAGE_LABEL, toHash, parseHash, type PageId } from "../lib/router.ts";
import { PAGE_ICON } from "./Icons.tsx";

/**
 * 侧栏导航。
 *
 * 条目从 `NAV_GROUPS` 推导 —— 那份清单是路由分派的同一个真相。手写一份会分叉
 * （纪律 #4），而分叉方向是「导航上有的页面路由不认识」或反之。
 *
 * 条目是真实的 `<a href="#page">`：中键、新标签页打开、复制链接都能用。
 * 点击只改 hash，由 `useViewState` 的 hashchange 订阅切换页面。
 *
 * 选中态是一块实色圆角「胶囊」（surface）+ 加粗 + 图标换 accent-fg，外加 `aria-current`，
 * 不只靠颜色。不用 `accent-fill` 做底：它只有 `on-accent-fill` 一个合格前景，
 * 徽标等次要文字压在上面不可读。
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
      {NAV_GROUPS.map((group, gi) => (
        /* 分组小标题只在展开时显示；收起时用一条细线分隔，读屏仍听到分组名。 */
        <div key={gi} role="group" aria-label={group.label ?? "常用"} className={gi > 0 ? "mt-3" : ""}>
          {group.label !== null &&
            (collapsed ? (
              <div className="mx-4 mb-2 border-t border-border-strong" aria-hidden="true" />
            ) : (
              <p className="mb-1 px-5 text-label-12 font-medium text-text-muted" aria-hidden="true">
                {group.label}
              </p>
            ))}
          <ul className="flex flex-col gap-0.5 px-2">
          {group.pages.map((page: PageId) => {
            const active = page === current;
            const showBadge = page === "start" && badge !== undefined && badge !== null;
            return (
              <li key={page}>
                <a
                  href={toHash({ ...parseHash(""), page })}
                  onClick={onNavigate}
                  /* 触摸目标 ≥44px。 */
                  className={`group relative flex min-h-[44px] items-center gap-3 rounded-md no-underline transition-colors ${
                    collapsed ? "justify-center px-0" : "px-3"
                  } ${
                    active
                      ? "bg-surface font-medium text-text dark:bg-surface-active"
                      : "text-text-muted hover:bg-surface-hover hover:text-text active:bg-surface-active"
                  }`}
                  /* 屏幕阅读器要知道哪个是当前页 —— 颜色与边框它读不到。 */
                  aria-current={active ? "page" : undefined}
                  {...(collapsed ? { "aria-label": PAGE_LABEL[page], title: PAGE_LABEL[page] } : {})}
                >
                  <span className={active ? "text-accent-fg" : ""}>{PAGE_ICON[page]}</span>
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
                        className="rounded-full bg-surface-active px-2 text-label-12 text-text"
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
        </div>
      ))}
    </nav>
  );
}
