/**
 * 显示用的格式化函数。
 *
 * 时长与时间在多个页面出现（运行时长、冷却剩余、批测耗时、订阅拉取时间），
 * 集中在这里让同一个量在每一页都是同一种措辞。
 */

/**
 * 毫秒的人可读形态。
 *
 * 一小时内按「分钟」取整；更长的时长用两级单位（「22小时21分」「3天4小时」），
 * 因为网关运行时长以天计，只给分钟会得到「1341分钟」这种要读者自己换算的数。
 * 两级时向下取整：显示「22小时21分」时实际已过去的时间不会少于这个值。
 */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  if (ms < 3_600_000) {
    const minutes = Math.round(ms / 60_000);
    // 59.6 分钟取整成 60 时进位到小时，避免出现「60分钟」。
    return minutes < 60 ? `${minutes}分钟` : "1小时";
  }
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1440) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return m === 0 ? `${h}小时` : `${h}小时${m}分`;
  }
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  return h === 0 ? `${d}天` : `${d}天${h}小时`;
}

const LOCAL_TIME = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * ISO 时间戳的本地时间显示。
 *
 * 服务端给的是 UTC 的 ISO 串；直接截取会让用户看到比墙上时钟差若干小时的时间。
 * 无法解析时原样返回，不显示「Invalid Date」。
 */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return LOCAL_TIME.format(date);
}
