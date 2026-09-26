/**
 * 耗时测量，凡是 `clock() - startedAt` 都走这里（纪律 #4）。夹成非负整数：
 * 注入的时钟或 NTP 回拨会产生小数/负数，而 STRICT 表的 INTEGER 列与
 * `ProbeResultSchema` 会拒绝它们。
 */
export function elapsedMs(clock: () => number, startedAt: number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}
