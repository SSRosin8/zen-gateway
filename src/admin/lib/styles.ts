/**
 * 表单控件的共用类名。输入框、下拉框、文本域只有这一处定义：各文件各写一份时，
 * 改一次风格要改十几处，漏掉的那几处就是界面上「不一样的那个框」。
 *
 * 浅色下是白底实色框、深色下落回页面底色；聚焦时边框换 accent-fg，外加全局 2px 焦点环。
 */
export const FIELD =
  "min-h-[44px] rounded-sm border border-border-strong bg-surface px-3 transition-colors placeholder:text-text-muted focus-visible:border-accent-fg disabled:cursor-not-allowed disabled:bg-surface-active disabled:text-text-muted dark:bg-bg";

/** 文本域：同一套边框与底色，高度由行数决定。 */
export const TEXTAREA =
  "rounded-sm border border-border-strong bg-surface px-3 py-2 transition-colors placeholder:text-text-muted focus-visible:border-accent-fg dark:bg-bg";
