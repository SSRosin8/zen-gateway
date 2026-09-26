import { describe, expect, it } from "vitest";
import { formatLocalTime, humanMs } from "../../src/admin/lib/format.ts";

/*
 * 时长与时间的显示。运行时长以天计、冷却以分钟计、批测以秒计，
 * 三者共用 `humanMs`，所以每一档的边界都要钉住。
 */

describe("humanMs", () => {
  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1秒"],
    [59_000, "59秒"],
    [90_000, "2分钟"],
    [15 * 60_000, "15分钟"],
    // 59.6 分钟四舍五入为 60 时进位，不显示「60分钟」。
    [59.6 * 60_000, "1小时"],
    [3_600_000, "1小时"],
    [(22 * 60 + 21) * 60_000, "22小时21分"],
    [(22 * 60 + 21) * 60_000 + 59_000, "22小时21分"],
    [24 * 3_600_000, "1天"],
    [(3 * 24 + 4) * 3_600_000 + 30 * 60_000, "3天4小时"],
  ])("%d ms → %s", (ms, expected) => {
    expect(humanMs(ms)).toBe(expected);
  });

  it("运行时长不会显示成上千分钟", () => {
    // 回归：只有分钟一档时 22 小时显示为「1341分钟」。
    expect(humanMs(1341 * 60_000)).not.toMatch(/分钟/);
  });
});

describe("formatLocalTime", () => {
  it("按本地时区格式化，而不是截取 UTC 字符串", () => {
    const iso = "2026-09-25T10:00:00.000Z";
    const expected = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(iso));
    expect(formatLocalTime(iso)).toBe(expected);
  });

  it("无法解析时原样返回，不显示 Invalid Date", () => {
    expect(formatLocalTime("不是时间")).toBe("不是时间");
  });
});
