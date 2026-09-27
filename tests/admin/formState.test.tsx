import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { useFormState, useLeaveGuard } from "../../src/admin/lib/formState.ts";

/*
 * 设置表单的「未保存」状态与离页守卫。
 *
 * 守卫改的是 hash 路由的全局行为，出错的两个方向都伤人：拦不住会丢输入；
 * 拦过头（同页换标签也弹、没改也弹）会让每次点导航都多一个对话框。
 */

afterEach(async () => {
  // 先卸载：守卫还在时把 hash 清空会触发真的 confirm。
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
  // 改 `location.hash` 的 hashchange 是异步派发的：等它们落地，别漏进下一条用例。
  await new Promise((r) => setTimeout(r, 20));
});

describe("useFormState", () => {
  it("没改时跟上服务端值；改过后不覆盖输入，只标出服务端已变", () => {
    const { result, rerender } = renderHook(({ server }) => useFormState(server), { initialProps: { server: { a: "1" } } });
    expect(result.current.dirty).toBe(false);

    rerender({ server: { a: "2" } });
    expect(result.current.value).toEqual({ a: "2" });
    expect(result.current.serverChanged).toBe(false);

    act(() => result.current.set({ a: "mine" }));
    expect(result.current.dirty).toBe(true);
    rerender({ server: { a: "3" } });
    expect(result.current.value).toEqual({ a: "mine" });
    expect(result.current.serverChanged).toBe(true);

    act(() => result.current.reset());
    expect(result.current.value).toEqual({ a: "3" });
    expect(result.current.dirty).toBe(false);
  });

  it("改过期间服务端变了，又改回原值：载入服务端最新值，不停在旧值", () => {
    const { result, rerender } = renderHook(({ server }) => useFormState(server), { initialProps: { server: { a: "1", b: "x" } } });
    act(() => result.current.set({ a: "mine", b: "x" }));
    rerender({ server: { a: "1", b: "y" } });
    expect(result.current.serverChanged).toBe(true);
    act(() => result.current.set({ a: "1", b: "x" }));
    expect(result.current.value).toEqual({ a: "1", b: "y" });
    expect(result.current.dirty).toBe(false);
    expect(result.current.serverChanged).toBe(false);
  });

  it("markSaved 以刚保存的值为新基准；改回原值不算未保存", () => {
    const { result } = renderHook(() => useFormState({ a: "1" }));
    act(() => result.current.set({ a: "2" }));
    act(() => result.current.markSaved());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.set({ a: "3" }));
    act(() => result.current.set({ a: "2" }));
    expect(result.current.dirty).toBe(false);
  });
});

function Guarded({ dirty }: { dirty: boolean }) {
  useLeaveGuard(dirty);
  return <p>{dirty ? "有修改" : "无修改"}</p>;
}

/** 模拟一次 hash 导航：浏览器先改 location，再派发 hashchange。 */
function navigateTo(hash: string) {
  const oldURL = window.location.href;
  window.history.replaceState(null, "", hash);
  const event = new HashChangeEvent("hashchange", { oldURL, newURL: window.location.href });
  window.dispatchEvent(event);
  return event;
}

describe("useLeaveGuard", () => {
  it("有修改时换页先确认；取消则回到原页，且后续路由监听收不到这次切换", () => {
    window.history.replaceState(null, "", "#gateway");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const router = vi.fn();
    window.addEventListener("hashchange", router);
    render(<Guarded dirty />);

    navigateTo("#workers");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(router).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#gateway");
    window.removeEventListener("hashchange", router);
  });

  it("两个表单都改过：只问一次，取消后恢复原页也不再问", async () => {
    window.history.replaceState(null, "", "#gateway");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <>
        <Guarded dirty />
        <Guarded dirty />
      </>,
    );
    navigateTo("#workers");
    // 恢复 hash 触发的那次 hashchange 是异步派发的。
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.hash).toBe("#gateway");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("两个表单中一个保存后，另一个仍然拦", () => {
    window.history.replaceState(null, "", "#gateway");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = render(
      <>
        <Guarded dirty />
        <Guarded dirty />
      </>,
    );
    rerender(
      <>
        <Guarded dirty={false} />
        <Guarded dirty />
      </>,
    );
    navigateTo("#workers");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("确认离开则放行；同页只改查询参数不打扰", () => {
    window.history.replaceState(null, "", "#gateway");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Guarded dirty />);

    navigateTo("#gateway?tab=routing");
    expect(confirm).not.toHaveBeenCalled();
    navigateTo("#workers");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("#workers");
  });

  it("没有修改时不拦，也不注册 beforeunload", () => {
    const add = vi.spyOn(window, "addEventListener");
    const confirm = vi.spyOn(window, "confirm");
    render(<Guarded dirty={false} />);
    expect(screen.getByText("无修改")).toBeInTheDocument();
    navigateTo("#workers");
    expect(confirm).not.toHaveBeenCalled();
    expect(add.mock.calls.map((c) => c[0])).not.toContain("beforeunload");
  });

  it("有修改时关页走浏览器原生提示", () => {
    render(<Guarded dirty />);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
