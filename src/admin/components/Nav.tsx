import { PAGES, PAGE_LABEL, toHash, parseHash, type PageId } from "../lib/router.ts";

/**
 * 顶部导航。
 *
 * 条目从 `PAGES` 推导 —— 那份清单是路由分派的同一个真相。手写一份会分叉
 * （纪律 #4），而分叉方向是「导航上有的页面路由不认识」或反之。
 *
 * 条目是真实的 `<a href="#page">`：中键、新标签页打开、复制链接都能用。
 * 点击只改 hash，由 `useViewState` 的 hashchange 订阅切换页面，
 * 所以不需要 onClick。
 *
 * 选中态用 **3px 下边框实色 + 文字加粗**，不用 `accent-fill` 做背景：
 * 那个 token 只有 `on-accent-fill` 一个合格前景（5.90），而导航项在移动端会
 * 换行，用它做底会让文字不可读。
 */
export function Nav({ current }: { current: PageId }) {
  return (
    <nav className="mb-6 border-b border-border-strong" aria-label="主导航">
      <ul className="flex flex-wrap gap-1">
        {PAGES.map((page) => {
          const active = page === current;
          return (
            <li key={page}>
              <a
                href={toHash({ ...parseHash(""), page })}
                /* 触摸目标 ≥44px。 */
                className={`inline-flex min-h-[44px] items-center border-b-[3px] px-3 font-medium no-underline sm:px-4 ${
                  active
                    ? "border-b-accent-fg text-accent-fg"
                    : "border-b-transparent text-text-muted"
                }`}
                /* 屏幕阅读器要知道哪个是当前页 —— 颜色与边框它读不到。 */
                aria-current={active ? "page" : undefined}
              >
                {PAGE_LABEL[page]}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
