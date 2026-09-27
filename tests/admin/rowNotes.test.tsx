import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import * as adminApi from "../../src/admin/lib/api.ts";
import { useRowNotes } from "../../src/admin/lib/rowNotes.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRowNotes", () => {
  it("两个补丁重叠时，先结束的那个不提前放开 busy", async () => {
    const release: Array<() => void> = [];
    vi.spyOn(adminApi, "patchConfig").mockImplementation(() => new Promise<void>((r) => release.push(r)));
    const { result } = renderHook(() => useRowNotes());
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.apply(["a"], { proxies: { update: { a: { enabled: false } } } }, "已停用");
      second = result.current.apply(["b"], { proxies: { update: { b: { name: "新名" } } } }, "已改名");
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      release[0]!();
      await first;
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      release[1]!();
      await second;
    });
    expect(result.current.busy).toBe(false);
  });
});
