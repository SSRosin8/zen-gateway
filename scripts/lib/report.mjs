/**
 * CLI 输出格式 —— `setup` 与 `doctor` 共用。
 *
 * 两个脚本都在报告「一串带层级的检查结果」,格式若各写一份,两条命令的输出
 * 会慢慢分叉成两种风格,而用户是同一个人。
 *
 * ## 不上色
 *
 * ANSI 转义在被重定向到文件、粘进 issue、或在不支持的终端里会变成乱码,
 * 而这两个脚本的输出**正是用来粘给别人看的**(诊断信息)。符号足够区分。
 */

/** 层级状态。`warn` 与 `fail` 必须分开 —— 见 doctor 的「只报第一个失败的层」。 */
export const MARK = {
  pass: "✓",
  fail: "✗",
  warn: "!",
  skip: "·",
  info: " ",
};

export function line(status, text) {
  console.log(`  ${MARK[status] ?? " "} ${text}`);
}

/** 缩进一级的补充说明。用于「下一步建议」与实测值。 */
export function detail(text) {
  for (const row of String(text).split("\n")) {
    console.log(`      ${row}`);
  }
}

export function heading(text) {
  console.log(`\n── ${text} ──`);
}

/**
 * 「下一步建议」。
 *
 * 独立成一个函数是因为它是**诊断工具的全部价值所在**:一句
 * 「第 3 层失败」对用户毫无帮助,而「跑这条命令」才是他要的。
 * `doctor` 的验收行为之一就是「只报第一个失败的层 + 下一步建议」,
 * 所以它不该是某个 `console.log` 的随手写法。
 */
export function nextStep(text) {
  console.log(`\n  下一步:`);
  for (const row of String(text).split("\n")) {
    console.log(`    ${row}`);
  }
}

/**
 * 毫秒数的人可读形态。
 *
 * 诊断输出里 `3600000` 要读者自己换算是不友好的,而年龄/剩余冷却这类值
 * 在两个脚本里都出现。
 */
export function humanMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) return `${Math.round(ms / 60_000)}分钟`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}小时`;
  return `${Math.round(ms / 86_400_000)}天`;
}
