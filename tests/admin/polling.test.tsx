import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useBatchProbe } from "../../src/admin/lib/api.ts";
import { INITIAL, pollIntervalMs } from "../../src/shared/batchProbe.ts";
import type { BatchProgress } from "../../src/shared/batchProbe.ts";

/*
 * 轮询节流 —— 第八轮审核查出的一个**活缺陷**在这里钉住。
 *
 * 原实现把 `progress` 放进了 effect 的依赖数组,而 effect 自己就在
 * `setProgress`。加上 `safeParse` 每次返回**新对象**(即使进度分毫未变),
 * 依赖次次都变 → effect 重挂 → 立刻再发一次 → 排好的 `setTimeout` 被
 * cleanup 清掉,间隔永远等不到。
 *
 * 实测后果:200ms 内 **27691 个**请求(设计值是空闲时每 5000ms 一个),
 * 且 `document.hidden` 那条降频同样失效。本机网关是单线程的,而每个请求
 * 都要跑一次 `batch.snapshot()` —— 打开代理池页等于给自己压测。
 *
 * 所以这里断言的是**请求条数**而不是「有没有 setTimeout」:后者在缺陷版本里
 * 也成立(它确实排了,只是立刻被清掉)。断言必须落在可观察的后果上。
 */

afterEach(cleanup);

/** 让轮询的排程与真实时钟脱钩,用请求数而不是等待时间判定。 */
function stubFetch(body: BatchProgress): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    // 关键:每次都返回**新对象**,复现 `safeParse` 的身份变化。
    return { ok: true, json: async () => ({ ...body }) } as unknown as Response;
  });
  return () => calls;
}

describe("useBatchProbe 的轮询节流", () => {
  it("空闲态在 200ms 内只发一次 —— 不自激成忙轮询", async () => {
    const count = stubFetch(INITIAL);
    renderHook(() => useBatchProbe());

    await new Promise((r) => setTimeout(r, 200));

    /*
     * 空闲间隔 5000ms，所以 200ms 内应当只有首次那一发。
     * 缺陷版本这里是五位数。给一点余量但远低于「失控」的量级。
     */
    expect(count()).toBeLessThanOrEqual(2);
  });

  it("响应对象每次身份都不同时也不会重挂 effect", async () => {
    // 这一条单独存在:身份变化正是缺陷的成因,而它很容易在重构中回归
    // （例如把 ref 换回 state、或给依赖数组加回一个派生值）。
    const count = stubFetch(INITIAL);
    renderHook(() => useBatchProbe());

    await new Promise((r) => setTimeout(r, 150));
    const first = count();
    await new Promise((r) => setTimeout(r, 150));

    // 两个窗口都没有新增请求(仍在 5000ms 间隔内)。
    expect(count()).toBe(first);
  });

  it("后台标签页降到 5000ms —— `document.hidden` 那条分支真的在用", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      const count = stubFetch(INITIAL);
      renderHook(() => useBatchProbe());
      await new Promise((r) => setTimeout(r, 200));
      expect(count()).toBeLessThanOrEqual(2);
    } finally {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });

  it("卸载后不再发请求", async () => {
    const count = stubFetch(INITIAL);
    const { unmount } = renderHook(() => useBatchProbe());
    await new Promise((r) => setTimeout(r, 50));
    const atUnmount = count();
    unmount();
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(atUnmount);
  });

  it("运行中的间隔比空闲短 —— 两个值都来自 `pollIntervalMs`", () => {
    /*
     * 间隔本身由纯函数决定,这里只钉「两段确实不同」,
     * 避免在组件测试里重写一份 500/5000（纪律 #4）。
     */
    const running: BatchProgress = { ...INITIAL, state: "running", mainTotal: 3 };
    expect(pollIntervalMs(running)).toBeLessThan(pollIntervalMs(INITIAL));
  });
});
