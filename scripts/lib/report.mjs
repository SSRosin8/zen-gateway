/**
 * CLI 输出格式 —— `setup` 与 `doctor` 共用，保持两条命令输出风格一致。
 * 不上色：输出常被重定向或粘给别人看，ANSI 转义会变成乱码。
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

/** 「下一步建议」：诊断输出要告诉用户该跑什么，而不只是哪层失败。 */
export function nextStep(text) {
  console.log(`\n  下一步:`);
  for (const row of String(text).split("\n")) {
    console.log(`    ${row}`);
  }
}

/** 毫秒数的人可读形态（年龄、剩余冷却等）。 */
export function humanMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) return `${Math.round(ms / 60_000)}分钟`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}小时`;
  return `${Math.round(ms / 86_400_000)}天`;
}
