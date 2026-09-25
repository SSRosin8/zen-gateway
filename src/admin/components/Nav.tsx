import { PAGES, PAGE_LABEL, type PageId } from "../lib/router.ts";

/**
 * 顶部导航。
 *
 * 条目从 `PAGES` 推导 —— 那份清单是路由分派的同一个真相。手写一份会分叉
 * （纪律 #4），而分叉方向是「导航上有的页面路由不认识」或反之。
 *
 * 选中态用 **3px 下边框实色 + 文字加粗**，不用 `accent-fill` 做背景:
 * 那个 token 只有 `on-accent-fill` 一个合格前景（5.90），其余压上去全部
 * 不及格。而导航项在移动端会换行、文字可能超出，用它做底会让文字不可读。
 */
export function Nav({
  current,
  onNavigate,
}: {
  current: PageId;
  onNavigate: (page: PageId) => void;
}) {
  return (
    <nav className="mb-6 border-b border-border-strong" aria-label="主导航">
      <ul className="flex flex-wrap gap-1">
        {PAGES.map((page) => {
          const active = page === current;
          return (
            <li key={page}>
              <button
                type="button"
                onClick={() => onNavigate(page)}
                /* 触摸目标 ≥44px（移动端无障碍要求）。 */
                className={`min-h-[44px] border-b-[3px] px-4 font-medium ${
                  active
                    ? "border-b-accent-fg text-accent-fg"
                    : "border-b-transparent text-text-muted"
                }`}
                /* 屏幕阅读器要知道哪个是当前页 —— 颜色与边框它读不到。 */
                aria-current={active ? "page" : undefined}
              >
                {PAGE_LABEL[page]}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
