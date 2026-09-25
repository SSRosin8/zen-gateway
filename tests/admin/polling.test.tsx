import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useBatchProbe } from "../../src/admin/lib/api.ts";
import { INITIAL, pollIntervalMs } from "../../src/shared/batchProbe.ts";
import type { BatchProgress } from "../../src/shared/batchProbe.ts";
import { BatchProgressSchema, INITIAL_BATCH_VIEW, type BatchProgressView } from "../../src/shared/contract.ts";

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
 *
 * ## fixture 必须能过 `BatchProgressSchema`（第十轮审核查出）
 *
 * 这里先前喂的是 reducer 的 `INITIAL`,而**它过不了那个 schema**
 * （少一个 `elapsedMs`）。于是 `api.ts` 的 `safeParse` 失败 →
 * `setProgress` 从不执行 → 而忙轮询的成因链条正是
 * 「`setProgress` → 依赖数组变 → effect 重挂」。第一环断掉,
 * 整组断言就测在一条不可达的路径上：把 `progress` 放回依赖数组
 * （即第八轮修掉的那个缺陷原样回归）后,这些用例**依然全绿**。
 *
 * `contract.ts` 自己解释过两种形态为何不同（「不复用 reducer 的 `INITIAL`:
 * 那个少一个 `elapsedMs`」）—— 而测试用的偏是 reducer 那个。
 *
 * 所以除了换 fixture,还加了一条**前置断言**：确认 fixture 真的能过 schema。
 * 少了它,下一次 schema 加字段时这组用例会再次静默退化成空壳。
 */

afterEach(cleanup);

/** 让轮询的排程与真实时钟脱钩,用请求数而不是等待时间判定。 */
function stubFetch(body: BatchProgressView): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls += 1;
    // 关键:每次都返回**新对象**,复现 `safeParse` 的身份变化。
    return { ok: true, json: async () => ({ ...body }) } as unknown as Response;
  });
  return () => calls;
}

describe("useBatchProbe 的轮询节流", () => {
  it("**前置：fixture 真的能过 schema** —— 否则下面全组测在不可达路径上", () => {
    /*
     * 这条不是形式主义。第十轮审核实测：用 reducer 的 `INITIAL` 时
     * `safeParse` 失败、`setProgress` 从不执行，于是下面四条用例在
     * 缺陷版本（`progress` 回到依赖数组）下依然全绿 —— 而同一变异用
     * 真实线上形态跑同一个 hook 是 26000+ 个请求。
     */
    expect(BatchProgressSchema.safeParse(INITIAL_BATCH_VIEW).success).toBe(true);
  });

  it("空闲态在 200ms 内只发一次 —— 不自激成忙轮询", async () => {
    const count = stubFetch(INITIAL_BATCH_VIEW);
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
    const count = stubFetch(INITIAL_BATCH_VIEW);
    renderHook(() => useBatchProbe());

    await new Promise((r) => setTimeout(r, 150));
    const first = count();
    await new Promise((r) => setTimeout(r, 150));

    // 两个窗口都没有新增请求(仍在 5000ms 间隔内)。
    expect(count()).toBe(first);
  });

  it("后台标签页降到 5000ms —— `document.hidden` 那条分支真的在用", async () => {
    /*
     * 判据必须用**运行中**的进度，不能用空闲的。
     *
     * 空闲时 `pollIntervalMs` 本身就是 5000，与 `document.hidden` 的 5000
     * 完全相同 —— 于是那条分支在空闲态下不可观测（第十轮审核实测：把
     * `document.hidden` 改成 `false` 后这条用例照样绿）。运行中是 500ms，
     * 两者差 10 倍，这才有可测的差别。
     */
    const running: BatchProgressView = { ...INITIAL_BATCH_VIEW, state: "running", mainTotal: 3 };

    /*
     * 窗口要够长。间隔读的是 `latest.current`（ref），首发时它还是初始值，
     * 所以第二发之后才按 500ms 排 —— 220ms 只够一发，两边都是 1，
     * 那样这条又变成不可观测的。1200ms 下前台约 3 发、后台仍是 1 发。
     */
    const fg = stubFetch(running);
    const { unmount } = renderHook(() => useBatchProbe());
    await new Promise((r) => setTimeout(r, 1200));
    const foreground = fg();
    unmount();

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    try {
      const bg = stubFetch(running);
      renderHook(() => useBatchProbe());
      await new Promise((r) => setTimeout(r, 1200));

      // 后台 5000ms，同一窗口内只有首发。
      expect(bg()).toBeLessThanOrEqual(2);
      // 而且前台确实更多 —— 否则这条在"两边都只发一次"时也会绿。
      expect(foreground).toBeGreaterThan(bg());
    } finally {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
    }
  });

  it("**在途的轮询响应在用户动作之后被丢掉** —— 否则「点了取消又跳回探测中」", async () => {
    /*
     * generation 守卫：每次用户动作递增它，轮询响应到达时若 generation 已变，
     * 那条响应描述的是一个已经过时的世界。
     *
     * 这条要观测的是**闪烁**，所以必须让一次轮询响应卡在飞行途中、
     * 期间发出动作。少了它那个守卫没有任何东西守着（第十轮审核实测：
     * 去掉 `generation.current === myGeneration` 后全组仍绿）。
     */
    const running: BatchProgressView = { ...INITIAL_BATCH_VIEW, state: "running", mainTotal: 5, mainDone: 2 };
    const cancelled: BatchProgressView = { ...INITIAL_BATCH_VIEW, state: "idle", failureKind: "cancelled" };

    let releasePoll: (() => void) | undefined;
    let pollCalls = 0;

    vi.stubGlobal("fetch", async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        // 用户动作：立刻返回「已取消」。
        return { ok: true, json: async () => ({ ...cancelled }) } as unknown as Response;
      }
      pollCalls += 1;
      if (pollCalls === 1) {
        // 第一发轮询卡住 —— 它描述的是「还在跑」，而用户马上要取消。
        await new Promise<void>((r) => {
          releasePoll = r;
        });
      }
      return { ok: true, json: async () => ({ ...running }) } as unknown as Response;
    });

    const { result } = renderHook(() => useBatchProbe());

    // 等第一发轮询进入飞行状态。
    const deadline = Date.now() + 2000;
    while (releasePoll === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(releasePoll).toBeDefined();

    // 用户点取消 —— generation 递增，状态变成「已取消」。
    await act(async () => {
      await result.current.send("cancel");
    });
    expect(result.current.progress.state).toBe("idle");

    // 现在放那条陈旧的轮询响应过来。它必须被丢掉。
    await act(async () => {
      releasePoll?.();
      await new Promise((r) => setTimeout(r, 50));
    });

    // 少了守卫这里会跳回 running —— 那正是用户看到的闪烁。
    expect(result.current.progress.state).toBe("idle");
  }, 20_000);

  it("卸载后不再发请求", async () => {
    const count = stubFetch(INITIAL_BATCH_VIEW);
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
