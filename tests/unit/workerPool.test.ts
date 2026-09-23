import { describe, expect, it } from "vitest";
import { isUsable, WorkerPool } from "../../src/core/routing/workerPool.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { FAILURE_KINDS, shouldCooldown } from "../../src/core/failures.ts";

/**
 * Worker 池与就绪判定。时钟全部注入,抖动固定为 0 以断言确切时长。
 */

const NOW = 1_800_000_000_000;

type WorkerSpec = {
  id: string;
  kind?: "anonymous" | "authenticated";
  apiKey?: string;
  enabled?: boolean;
  proxyId?: string | null;
};

function config(workers: WorkerSpec[]): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "unit-test-relay-token-x" },
    workers: workers.map((w) => ({
      id: w.id,
      name: "",
      kind: w.kind ?? "authenticated",
      apiKey: w.apiKey ?? `fake-key-${w.id}-not-real`,
      enabled: w.enabled ?? true,
      proxyId: w.proxyId ?? null,
    })),
  });
}

describe("isUsable", () => {
  it("停用的不可用", () => {
    const cfg = config([{ id: "w1", enabled: false }]);
    expect(isUsable(cfg.workers[0]!)).toBe(false);
  });

  it("没有 apiKey 的不可用,即便 kind 声明是匿名", () => {
    /*
     * 上游已于 2026-09-16 前后关闭免 key 通道(免费模型返回 403 FreeTierError)。
     * 没有 key 的 Worker 发出去必定失败,放进候选链只会白占一次尝试,
     * 并把真实原因(没配 key)埋进重试日志。
     *
     * 按「有没有 key」而不按 kind 判断:kind 是用户的声明,
     * key 是能不能用的事实,后者才是调度该依据的。
     */
    const cfg = config([{ id: "w1", kind: "anonymous", apiKey: "" }]);
    expect(isUsable(cfg.workers[0]!)).toBe(false);
  });

  it("只有空白的 apiKey 也不可用", () => {
    const cfg = config([{ id: "w1", kind: "anonymous", apiKey: "   " }]);
    expect(isUsable(cfg.workers[0]!)).toBe(false);
  });

  it("启用 + 有 key 才可用", () => {
    const cfg = config([{ id: "w1" }]);
    expect(isUsable(cfg.workers[0]!)).toBe(true);
  });
});

describe("sync", () => {
  it("只收可用的 Worker", () => {
    const pool = new WorkerPool(
      config([
        { id: "w1" },
        { id: "w2", enabled: false },
        { id: "w3", kind: "anonymous", apiKey: "" },
      ]),
    );
    expect(pool.all().map((w) => w.id)).toEqual(["w1"]);
  });

  it("保留配置顺序 —— 用户手排的优先级不能被打乱", () => {
    const pool = new WorkerPool(config([{ id: "wb" }, { id: "wa" }, { id: "wc" }]));
    expect(pool.all().map((w) => w.id)).toEqual(["wb", "wa", "wc"]);
  });

  it("热更新保留同 id 的冷却状态", () => {
    /*
     * 不保留会让配置热更新变成一次"全员复活":用户在管理后台改个端口,
     * 所有正在冷却的 Worker 立刻重新就绪,于是刚被限流的账号马上又被打一遍。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "600", config: cfg, now: NOW, jitter: 0 });
    expect(pool.isReady("w1", NOW)).toBe(false);

    // 换一份新配置对象(引用不同),同 id 同 key。
    pool.sync(config([{ id: "w1" }, { id: "w2" }]));
    expect(pool.isReady("w1", NOW)).toBe(false);
    expect(pool.get("w1")?.cooldownUntil).toBe(NOW + 600_000);
  });

  it("apiKey 变了就重置冷却", () => {
    /*
     * 换 key 是用户对「这个账号不能用」的**直接回应**。此时还让它继续冷却
     * 到期,用户会看到自己刚修好的 key 依然被跳过,合理推断是"改了没生效"。
     */
    const cfg = config([{ id: "w1", apiKey: "fake-old-key-not-real" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "auth", retryAfter: null, config: cfg, now: NOW, jitter: 0 });
    expect(pool.isReady("w1", NOW)).toBe(false);

    pool.sync(config([{ id: "w1", apiKey: "fake-new-key-not-real" }]));
    expect(pool.isReady("w1", NOW)).toBe(true);
    expect(pool.get("w1")?.consecutiveFails).toBe(0);
    expect(pool.get("w1")?.lastFailure).toBeNull();
  });

  it("proxyId 变了**不**重置冷却", () => {
    /*
     * 换出口不改变 Worker 的额度与鉴权状态,而限流与鉴权失败正是冷却的
     * 主要来源。重置会让"调一下出口"变成绕过冷却的后门。
     */
    const cfg = config([{ id: "w1", proxyId: null }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "600", config: cfg, now: NOW, jitter: 0 });

    pool.sync(config([{ id: "w1", proxyId: null }]));
    expect(pool.isReady("w1", NOW)).toBe(false);
  });

  it("删掉的 Worker 连状态一起消失", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "600", config: cfg, now: NOW, jitter: 0 });
    pool.sync(config([{ id: "w2" }]));
    expect(pool.has("w1")).toBe(false);
    expect(pool.get("w1")).toBeNull();
  });

  it("停用再启用**保留**冷却 —— 停用不是「用户修好了这个账号」", () => {
    /*
     * 先前这条断言的是相反的行为(「重新加回来的 Worker 不带旧冷却」),
     * 理由写的是「状态已随删除消失」。第五轮审核指出那是**实现细节泄漏成契约**:
     * `sync` 的 `previous` Map 从已被 `filter(isUsable)` 过滤的列表建,
     * 停用的 Worker 不在里面,于是冷却被清 —— 而这不是任何人的设计意图。
     *
     * 实测后果:429 `Retry-After: 900` 之后停用再启用,剩余冷却 900000ms → 0。
     * Phase 9 的管理后台点两下就能抹掉上游明确要求的等待,而那正是冷却
     * 存在的理由。
     *
     * 判断依据很直接:上游的限流不会因为我在本地改了一行配置而失效。
     * 只有**换 key** 才是「用户修好了这个账号」的信号(见上一条)。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "600", config: cfg, now: NOW, jitter: 0 });

    // 停用 → 移出池;再启用 → 冷却仍在。
    pool.sync(config([{ id: "w1", enabled: false }, { id: "w2" }]));
    expect(pool.has("w1")).toBe(false);
    pool.sync(config([{ id: "w1" }, { id: "w2" }]));
    expect(pool.isReady("w1", NOW)).toBe(false);
    expect(pool.get("w1")?.cooldownUntil).toBe(NOW + 600_000);
  });

  it("停用期间换了 key,再启用时仍然重置", () => {
    /*
     * 两条规则的交叉:停用保留状态,但换 key 重置。换 key 的信号更强,
     * 所以它赢 —— 否则「停用 → 换 key → 启用」这条很自然的修复流程
     * 会让用户看到自己刚换的 key 依然被跳过。
     */
    const cfg = config([{ id: "w1", apiKey: "fake-old-key-not-real" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "auth", retryAfter: null, config: cfg, now: NOW, jitter: 0 });

    pool.sync(config([{ id: "w1", apiKey: "fake-old-key-not-real", enabled: false }]));
    pool.sync(config([{ id: "w1", apiKey: "fake-new-key-not-real" }]));
    expect(pool.isReady("w1", NOW)).toBe(true);
    expect(pool.get("w1")?.consecutiveFails).toBe(0);
  });

  it("彻底删掉再加回来也保留 —— 与停用同理", () => {
    /*
     * 从 config 里删掉一个 Worker 再加回来,与停用再启用是同一件事:
     * 上游的限流状态与我的配置编辑无关。
     *
     * 这条与上面那条的区别只在「Worker 是否还在 config 里」,而那个区别
     * 对"该不该继续冷却"不承载任何信息。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "600", config: cfg, now: NOW, jitter: 0 });
    pool.sync(config([]));
    pool.sync(config([{ id: "w1" }]));
    expect(pool.isReady("w1", NOW)).toBe(false);
  });
});

describe("就绪与计数", () => {
  it("空池的 counts 是 0/0 —— poolHealth 据此报 empty", () => {
    const pool = new WorkerPool(config([]));
    expect(pool.counts(NOW)).toEqual({ ready: 0, total: 0 });
  });

  it("不存在的 Worker 不就绪,而不是抛错", () => {
    const pool = new WorkerPool(config([{ id: "w1" }]));
    expect(pool.isReady("nope", NOW)).toBe(false);
  });

  it("冷却到期的那一刻就算就绪(闭区间)", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0 });
    expect(pool.isReady("w1", NOW + 59_999)).toBe(false);
    expect(pool.isReady("w1", NOW + 60_000)).toBe(true);
  });
});

describe("markFailure", () => {
  it("按类别给出不同冷却时长", () => {
    const cfg = config([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const pool = new WorkerPool(cfg);
    const f = (id: string, kind: (typeof FAILURE_KINDS)[number]) =>
      pool.markFailure({ workerId: id, kind, retryAfter: null, config: cfg, now: NOW, jitter: 0 });

    expect(f("a", "rate_limit")).toBe(NOW + cfg.routing.cooldown.rateLimitMs);
    expect(f("b", "auth")).toBe(NOW + cfg.routing.cooldown.authFailMs);
    expect(f("c", "transport")).toBe(NOW + cfg.routing.cooldown.transportBaseMs);
  });

  it.each(FAILURE_KINDS.filter((k) => !shouldCooldown(k)))(
    "%s 不冷却,但仍然计数 —— 不变量 #4",
    (kind) => {
      /*
       * 计数要加是刻意的:诊断里"连续失败 12 次却从未冷却"正是
       * "客户端一直在发坏请求"这个结论的证据,跳过计数会把线索抹掉。
       */
      const cfg = config([{ id: "w1" }]);
      const pool = new WorkerPool(cfg);
      pool.markFailure({ workerId: "w1", kind, retryAfter: null, config: cfg, now: NOW, jitter: 0 });
      expect(pool.isReady("w1", NOW)).toBe(true);
      expect(pool.get("w1")?.consecutiveFails).toBe(1);
      expect(pool.get("w1")?.lastFailure).toBe(kind);
    },
  );

  it("连续失败让退避指数增长", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    const step = (now: number) =>
      pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now, jitter: 0 });

    expect(step(NOW)).toBe(NOW + 2_000);
    expect(step(NOW + 10_000)).toBe(NOW + 10_000 + 4_000);
    expect(step(NOW + 20_000)).toBe(NOW + 20_000 + 8_000);
  });

  it("冷却只延长,不被另一次失败缩短", () => {
    /*
     * 并发请求会让两次失败乱序到达。先算出的长冷却(429 的 15 分钟)若被
     * 后算出的短冷却(一次传输失败的 2 秒)覆盖,那个刚限流我们的上游会在
     * 2 秒后再被打一遍 —— 而 `Retry-After` 明确说了要等 15 分钟。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    const long = pool.get("w1")!.cooldownUntil;

    pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0 });
    expect(pool.get("w1")!.cooldownUntil).toBe(long);
    expect(pool.isReady("w1", NOW + 10_000)).toBe(false);
  });

  it("不存在的 Worker 返回 null,不抛错", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    expect(
      pool.markFailure({ workerId: "nope", kind: "auth", retryAfter: null, config: cfg, now: NOW, jitter: 0 }),
    ).toBeNull();
  });
});

describe("markSuccess", () => {
  it("清掉冷却与失败计数", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    pool.markSuccess("w1");
    expect(pool.isReady("w1", NOW)).toBe(true);
    expect(pool.get("w1")).toMatchObject({ consecutiveFails: 0, lastFailure: null });
  });

  it("成功后下一次失败从基准值重新起跳", () => {
    /*
     * 不清计数的后果:一个偶发失败过 5 次的 Worker,在成功服务几小时后
     * 再遇到一次传输失败,退避直接从 32 秒起跳 —— 而它明明是健康的。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    for (let i = 0; i < 4; i += 1) {
      pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0 });
    }
    pool.markSuccess("w1");
    expect(
      pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0 }),
    ).toBe(NOW + cfg.routing.cooldown.transportBaseMs);
  });

  it("不存在的 Worker 不抛错", () => {
    const pool = new WorkerPool(config([{ id: "w1" }]));
    expect(() => pool.markSuccess("nope")).not.toThrow();
  });
});

describe("snapshot", () => {
  it("**不含 apiKey** —— 它是凭证", () => {
    /*
     * 这个快照的用途是诊断导出与管理后台展示,两者都会被用户复制粘贴。
     */
    const cfg = config([{ id: "w1", apiKey: "fake-secret-key-not-real" }]);
    const pool = new WorkerPool(cfg);
    const json = JSON.stringify(pool.snapshot(NOW));
    expect(json).not.toContain("fake-secret-key-not-real");
    expect(json).not.toContain("apiKey");
  });

  it("报出剩余冷却时长,过期后为 0 而非负数", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0 });
    expect(pool.snapshot(NOW + 10_000)[0]).toMatchObject({
      ready: false,
      cooldownRemainingMs: 50_000,
    });
    expect(pool.snapshot(NOW + 999_999)[0]).toMatchObject({
      ready: true,
      cooldownRemainingMs: 0,
    });
  });

  it("带上 lastFailure,让「为什么在冷却」有答案", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "auth", retryAfter: null, config: cfg, now: NOW, jitter: 0 });
    expect(pool.snapshot(NOW)[0]?.lastFailure).toBe("auth");
  });
});
