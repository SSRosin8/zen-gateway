import { describe, expect, it } from "vitest";
import { poolHealth } from "../../src/shared/contract.ts";

/*
 * 空池不是健康池。
 *
 * `ready === total` 在 total 为 0 时为真，于是全新安装的第一眼会显示
 * 「全部健康」。这是首次使用体验里最误导的一种状态，必须是独立的一态。
 */
describe("poolHealth", () => {
  it("空池报 empty,不是 healthy", () => {
    expect(poolHealth({ ready: 0, total: 0 })).toBe("empty");
  });

  it("全部就绪报 healthy", () => {
    expect(poolHealth({ ready: 3, total: 3 })).toBe("healthy");
  });

  it("部分就绪报 degraded", () => {
    expect(poolHealth({ ready: 1, total: 3 })).toBe("degraded");
  });

  it("全部不就绪但池非空报 degraded,不是 empty", () => {
    expect(poolHealth({ ready: 0, total: 3 })).toBe("degraded");
  });
});
