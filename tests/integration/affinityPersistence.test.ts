import { describe, expect, it } from "vitest";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { useStatsFixture } from "./helpers/statsFixture.ts";

/**
 * 会话亲和持久化:绑定经 `AffinityStore` 落库,重启后恢复,且只存摘要。
 */

const { store, config, relay, makeApp, chatBody } = useStatsFixture();

describe("亲和持久化:重启后粘滞不归零", () => {
  it("重启后同一会话仍路由到原 Worker", async () => {
    const cfg = config();
    const session = "sticky-session-1";

    // 第一轮：建立绑定。
    const first = await makeApp(cfg);
    const r1 = await first.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r1.text();
    const firstWorker = r1.headers.get("x-zen-gateway-worker");
    expect(firstWorker).not.toBeNull();

    // 模拟重启：全新的 Scheduler（空内存），只通过 DB 恢复。
    const revived = new Scheduler({ affinitySink: store.affinityStore });
    const now = Date.now();
    revived.restoreAffinity(store.affinityStore.loadSessions(now), store.affinityStore.loadBlobs(now));

    const second = await makeApp(cfg, revived);
    const r2 = await second.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r2.text();

    expect(r2.headers.get("x-zen-gateway-worker")).toBe(firstWorker);
    // 命中的是恢复来的绑定，而不是"碰巧又选了同一个" ——
    // `sticky` 正是 select.ts 里会话亲和命中的那个 reason。
    expect(r2.headers.get("x-zen-gateway-route")).toBe("sticky");
  });

  it("不传 affinitySink 时重启后绑定归零(对照)", async () => {
    /*
     * 反向断言：证明上一条测的是**持久化**在起作用，
     * 而不是"候选链顺序恰好稳定"这种与本特性无关的原因。
     */
    const cfg = config();
    const session = "sticky-session-2";

    const first = await makeApp(cfg, new Scheduler());
    await (
      await first.request(
        "/v1/chat/completions",
        relay(chatBody(), { "x-opencode-session": session }),
      )
    ).text();

    // 没有 sink → 库里什么都没有。
    expect(store.affinityStore.loadSessions(Date.now())).toHaveLength(0);

    const revived = new Scheduler();
    const second = await makeApp(cfg, revived);
    const r2 = await second.request(
      "/v1/chat/completions",
      relay(chatBody(), { "x-opencode-session": session }),
    );
    await r2.text();
    // 空内存 → 走策略排序，不是亲和命中。
    expect(r2.headers.get("x-zen-gateway-route")).toBe("strategy");
  });

  it("会话绑定落库的是摘要,不是原始会话标识", async () => {
    const cfg = config();
    const session = "a-very-recognizable-session-id";
    const app = await makeApp(cfg);
    await (
      await app.request(
        "/v1/chat/completions",
        relay(chatBody(), { "x-opencode-session": session }),
      )
    ).text();

    const rows = store.affinityStore.loadSessions(Date.now());
    expect(rows).toHaveLength(1);
    // 原值绝不能进库 —— 它来自客户端，而这张表会进备份与诊断导出。
    expect(rows[0]?.hash).not.toContain("recognizable");
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
