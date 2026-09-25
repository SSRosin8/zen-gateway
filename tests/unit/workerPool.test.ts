import { describe, expect, it } from "vitest";
import { isWorkerReady, isUsable, WorkerPool } from "../../src/core/routing/workerPool.ts";
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

  it("匿名 Worker 没有 apiKey 也可用", () => {
    const cfg = config([{ id: "w1", kind: "anonymous", apiKey: "" }]);
    expect(isUsable(cfg.workers[0]!)).toBe(true);
  });

  it("匿名 Worker 的空白 apiKey 也可用", () => {
    const cfg = config([{ id: "w1", kind: "anonymous", apiKey: "   " }]);
    expect(isUsable(cfg.workers[0]!)).toBe(true);
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
    expect(pool.all().map((w) => w.id)).toEqual(["w1", "w3"]);
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
  it("清掉冷却与失败计数（尝试发出于冷却之后）", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    const until = pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 })!;
    // 发起时刻晚于冷却结束 —— 这次成功确实说明"现在能用"。
    pool.markSuccess("w1", until + 1);
    expect(pool.isReady("w1", NOW)).toBe(true);
    expect(pool.get("w1")).toMatchObject({ consecutiveFails: 0, lastFailure: null });
  });

  it("**发出于冷却生效之前的成功不清冷却** —— 它对「现在能用」零信息", () => {
    /*
     * 第十轮审核实测的严重缺陷。记账顺序由**上游响应到达顺序**决定：
     *
     *   请求A 发出 ── 上游慢 300ms ──→ 200 成功   ← 记账在后
     *   请求B 发出 → 立刻 429 Retry-After: 900    ← 记账在前
     *
     * 先前无条件 `cooldownUntil: 0`，于是请求 A 那次成功把上游明确要求的
     * 900 秒清成 0。而 429 通常是账号级的，多轮对话客户端天然并发 ——
     * 「一个 in-flight 请求恰好在 429 之前发出」是限流场景的常态。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    const until = pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 })!;

    // 这次成功在 NOW - 300 就发出了 —— 早于冷却生效（NOW）。
    pool.markSuccess("w1", NOW - 300);

    // 冷却必须还在：上游说的 900 秒不该被一次更早发出的请求推翻。
    expect(pool.isReady("w1", NOW)).toBe(false);
    expect(pool.get("w1")!.cooldownUntil).toBe(until);
    // 但计数照样清零 —— 那部分与 markNotBlamed 同处置。
    expect(pool.get("w1")).toMatchObject({ consecutiveFails: 0, lastFailure: null });
  });

  it("恰好等于冷却结束时刻算「之后」", () => {
    /*
     * 边界：`cooldownUntil` 等于发起时刻意味着冷却刚到期，那次尝试是在
     * 冷却之后发出的。用 `>` 而不是 `>=` 会让这一刻的成功白白不清冷却。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    const until = pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 })!;
    pool.markSuccess("w1", until);
    expect(pool.get("w1")!.cooldownUntil).toBe(0);
  });

  it("没有冷却时照常清零 —— 最常见的情形不受影响", () => {
    /*
     * 与上面几条配对：绝大多数成功发生在没有冷却的 Worker 上（`cooldownUntil`
     * 为 0），任何发起时刻都 >= 0，所以行为与改动前完全一致。
     * 少了这条，一个「永不清冷却」的实现也能让"不清"那条通过。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0 });
    pool.markSuccess("w1", NOW + 10_000);
    expect(pool.get("w1")!.cooldownUntil).toBe(0);
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
    // 发起时刻取到远晚于第 4 次退避之后 —— 这条验的是计数清零，不是冷却边界。
    pool.markSuccess("w1", NOW + 1_000_000);
    expect(
      pool.markFailure({ workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0 }),
    ).toBe(NOW + cfg.routing.cooldown.transportBaseMs);
  });

  it("不存在的 Worker 不抛错", () => {
    const pool = new WorkerPool(config([{ id: "w1" }]));
    expect(() => pool.markSuccess("nope", NOW)).not.toThrow();
  });

  it("非有限的发起时刻退回「清冷却」—— 保守方向是不要卡住一个能用的 Worker", () => {
    /*
     * `latencyMs` 若为 NaN，`now - latencyMs` 也是 NaN。两个方向都要选一个：
     * 不清 → 一个其实能用的 Worker 被冷却卡住；清 → 极端情况下提前解除。
     * 选后者与 `record` 里 `Number.isFinite` 的退回一致（那里退回 `now`），
     * 且这条路径要求 `latencyMs` 本身已经坏掉，而它由 `elapsedMs()` 产出。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    pool.markSuccess("w1", Number.NaN);
    expect(pool.get("w1")!.cooldownUntil).not.toBeNaN();
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

/* ================================================================== *
 * 非有限输入的守卫（第十轮审核）
 * ================================================================== */

describe("isWorkerReady 对非有限输入保守处理", () => {
  /*
   * 这两行 `Number.isFinite` 先前**零覆盖** —— 全仓没有任何测试给
   * `isWorkerReady` 喂过非有限值，删掉它们后 122 条相关测试全绿。
   *
   * 而它是**承重的**：穷举 `{NaN, ±Infinity, 0, 1, 1e15}` 的 36 种组合，
   * 与裸 `cooldownUntil <= now` 有 9 处分歧，其中
   * `cooldownUntil = -Infinity` 会让裸比较返回 `true` ——
   * 一个脏值把 Worker **误判成就绪**，那是不安全的方向。
   */

  const VALUES = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, 1e15];

  it("**没有任何非有限输入会被判成就绪**", () => {
    let checked = 0;
    const wrong: string[] = [];

    for (const until of VALUES) {
      for (const now of VALUES) {
        const bothFinite = Number.isFinite(until) && Number.isFinite(now);
        const ready = isWorkerReady(until, now);
        // 只要有一侧非有限，就必须判成不就绪。
        if (!bothFinite && ready) wrong.push(`until=${until} now=${now}`);
        checked += 1;
      }
    }

    expect(checked).toBe(VALUES.length * VALUES.length);
    expect(wrong, "这些非有限组合被误判成就绪").toEqual([]);
  });

  it("与裸比较**确实有分歧** —— 证明守卫不是装饰", () => {
    /*
     * 与上一条配对。少了它，一个「裸比较恰好也从不误判」的世界里
     * 上面那条会通过，而我们无从知道守卫有没有在做事。
     */
    const divergences = VALUES.flatMap((until) =>
      VALUES.filter((now) => isWorkerReady(until, now) !== until <= now).map(
        (now) => `until=${until} now=${now}`,
      ),
    );

    expect(divergences.length).toBeGreaterThan(0);
    // 最要紧的那个形态：裸比较说就绪，守卫说不就绪。
    expect(Number.NEGATIVE_INFINITY <= 0).toBe(true);
    expect(isWorkerReady(Number.NEGATIVE_INFINITY, 0)).toBe(false);
  });

  it("有限输入的行为与裸比较完全一致 —— 守卫不改变正常路径", () => {
    for (const until of [0, 1, 1e15]) {
      for (const now of [0, 1, 1e15]) {
        expect(isWorkerReady(until, now)).toBe(until <= now);
      }
    }
  });
});
