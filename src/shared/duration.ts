/** 毫秒数的人可读形态（年龄、剩余冷却等）。doctor 与管理面诊断共用。 */
export function humanMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) return `${Math.round(ms / 60_000)}分钟`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}小时`;
  return `${Math.round(ms / 86_400_000)}天`;
}

/** 「多久以前」：1 秒以内说「刚刚」，不写「1ms前」这种读起来像误差的数。 */
export function humanAgo(ms: number): string {
  return Number.isFinite(ms) && ms < 1000 ? "刚刚" : `${humanMs(ms)}前`;
}
