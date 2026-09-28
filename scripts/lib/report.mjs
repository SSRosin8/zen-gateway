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
  console.log(`\n  下一步：`);
  for (const row of String(text).split("\n")) {
    console.log(`    ${row}`);
  }
}

// 与管理面诊断共用一份实现。
export { humanAgo, humanMs } from "../../src/shared/duration.ts";
