import { describe, expect, it } from "vitest";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { digestOf } from "../../src/core/routing/affinity.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import type { AttemptRecord } from "../../src/core/upstream/retry.ts";

/**
 * 调度器 —— 四块的组合层。时钟与抖动全部注入。
 */

const NOW = 1_800_000_000_000;

function config(ids: string[], over: { affinityTtlMs?: number } = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "unit-test-relay-token-x" },
    ...(over.affinityTtlMs !== undefined ? { routing: { affinityTtlMs: over.affinityTtlMs } } : {}),
    workers: ids.map((id) => ({
      id,
      name: "",
      kind: "authenticated",
      apiKey: `fake-key-${id}-not-real`,
      enabled: true,
      proxyId: null,
    })),
  });
}

/** 抖动固定为 0,让冷却时长可断言。 */
function scheduler(): Scheduler {
  return new Scheduler({ jitter: () => 0 });
}

function attempt(over: Partial<AttemptRecord> & { workerId: string }): AttemptRecord {
  return {
    workerId: over.workerId,
    failure: over.failure ?? null,
    blameWorker: over.blameWorker ?? false,
    retryAfter: over.retryAfter ?? null,
    /*
     * Phase 7 给 `AttemptRecord` 加了 `status` / `latencyMs`（统计要按尝试
     * 记状态码与耗时）。调度器**不读**这两个字段 —— 它只依据
     * `failure` / `blameWorker` / `retryAfter` 判冷却，所以这里给中性默认值。
     *
     * 默认 `status: null` 而不是 200：调度的分支由 `failure` 决定，
     * 给一个成功的状态码会让"失败但 status=200"这种自相矛盾的入参
     * 看起来是合法的。null 表示"这一维度本用例不关心"。
     */
    status: over.status ?? null,
    latencyMs: over.latencyMs ?? 0,
  };
}

const plan = (s: Scheduler, cfg: Config, now = NOW, sessionHash: string | null = null, blobHashes: string[] = []) =>
  s.plan({ config: cfg, now, sessionHash, blobHashes });

describe("配置同步", () => {
  it("首次 plan 就自动同步,不必先手工 sync", () => {
    const cfg = config(["w1", "w2"]);
    expect(plan(scheduler(), cfg).targets.map((t) => t.workerId)).toEqual(["w1", "w2"]);
  });

  it("同一个配置对象不重复 sync", () => {
    /*
     * 这是引用比较的存在理由,而它**只是优化** —— `sync` 自己保留同 id 同 key
     * 的状态,所以每请求重跑一遍不改变任何行为。
     *
     * 正因如此,行为断言抓不到它:去掉那个提前返回后全部测试依然绿(变异
     * 验证的结果)。所以这里用**结构断言** —— 数 `config.workers` 被读了几次。
     * 不数就等于没有守住:一份 512 个 Worker 的配置每请求重建一个 Map 与
     * 一个数组,而这条路径在每个转发请求上。
     */
    const base = config(["w1", "w2"]);
    let workersReads = 0;
    const spy = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "workers") workersReads += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Config;

    plan(scheduler(), spy);
    const afterFirst = workersReads;
    expect(afterFirst).toBeGreaterThan(0);

    const s = scheduler();
    plan(s, spy);
    const afterSync = workersReads;
    for (let i = 0; i < 5; i += 1) plan(s, spy, NOW + i);
    // 后续 5 次 plan 不得再读 workers —— 配置没变就不该重建池。
    expect(workersReads).toBe(afterSync);
  });

  it("配置未变时反复 plan 不会丢掉冷却", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }), cfg, NOW);
    expect(plan(s, cfg).targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(plan(s, cfg).targets.map((t) => t.workerId)).toEqual(["w2"]);
  });

  it("换了配置对象则重新同步,并保留同 id 的冷却", () => {
    const s = scheduler();
    const first = config(["w1", "w2"]);
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }), first, NOW);

    const second = config(["w1", "w2"]);
    expect(plan(s, second).targets.map((t) => t.workerId)).toEqual(["w2"]);
  });

  it("热更新加进来的新 Worker 立刻可用", () => {
    const s = scheduler();
    expect(plan(s, config(["w1"])).targets).toHaveLength(1);
    expect(plan(s, config(["w1", "w2"])).targets).toHaveLength(2);
  });
});

describe("record:不变量 #4", () => {
  it("成功 → 清零", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w1", failure: "transport", blameWorker: true }), cfg, NOW);
    s.record(attempt({ workerId: "w1" }), cfg, NOW);
    expect(s.snapshot(cfg, NOW).workers[0]).toMatchObject({
      ready: true,
      consecutiveFails: 0,
      lastFailure: null,
    });
  });

  it("失败但 blameWorker 为 false → 也记成功,不冷却", () => {
    /*
     * 不变量 #4 的核心。`bad_request` 与出口配置错误都不归咎于 Worker ——
     * 否则一个客户端的坏请求会把所有健康 Worker 逐个打进冷却,
     * 一次拼错的请求体就能让整个网关瘫痪。
     */
    const cfg = config(["w1", "w2", "w3"]);
    const s = scheduler();
    for (const id of ["w1", "w2", "w3"]) {
      s.record(attempt({ workerId: id, failure: "bad_request", blameWorker: false }), cfg, NOW);
    }
    expect(plan(s, cfg).targets.map((t) => t.workerId)).toEqual(["w1", "w2", "w3"]);
  });

  it("blameWorker 为 false 时连续失败数被**清零**,不是加一", () => {
    /*
     * 这条是变异测试补出来的:去掉 `!record.blameWorker` 这个条件后,
     * 原有断言全部依然绿 —— 因为 `retry.ts` 里 `blameWorker === false`
     * 当前恒等于 `kind === "bad_request"`,而 `cooldownMs` 对它也返回 null。
     * 两层各自挡住,所以**冷却**行为看不出差别。
     *
     * 真正有差别的是失败计数:走 `markFailure` 会 +1,走 `markSuccess` 会清零。
     * 后果具体 —— 一个出口配置错误(同样不归咎 Worker)重复几次把计数推高,
     * 下一次真实的传输故障就从错误的指数级起跳,于是**一个配置问题让整个池
     * 的恢复速度变慢**,而两件事看起来毫无关系。
     *
     * 所以这里先攒一次真实失败,再用不归咎的失败去验它是否被清掉。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w1", failure: "transport", blameWorker: true }), cfg, NOW);
    expect(s.snapshot(cfg, NOW).workers[0]?.consecutiveFails).toBe(1);

    s.record(attempt({ workerId: "w1", failure: "bad_request", blameWorker: false }), cfg, NOW);
    expect(s.snapshot(cfg, NOW).workers[0]).toMatchObject({
      consecutiveFails: 0,
      lastFailure: null,
    });
  });

  it("不归咎的失败**不解除**一个已生效的冷却", () => {
    /*
     * 第五轮审核查出的缺陷,实测:
     *
     * ```
     * 429 Retry-After:900 之后  剩余 = 895000 ms
     * 一次出口配置错误之后      剩余 = 0 ms  ready = true
     * ```
     *
     * 先前 `record` 的非归咎分支直接复用 `markSuccess`,而它把
     * `cooldownUntil` 写 0 —— `markFailure` 里「冷却只延长不缩短」的
     * `Math.max` 被从旁路整个绕过。上游明确说了等 900 秒,我们 5 秒后
     * 就认为它可用。
     *
     * 触发不需要巧合:全员冷却时 `select` 仍会返回最早恢复的那个,
     * 所以那个坏请求真的会打到正在冷却的 Worker 上。
     *
     * 根因是「记成功」这个动作**过强**:「不归咎于 Worker」不等于
     * 「证明它现在能用」。出口配置错误尤其 —— 那次请求根本没到上游。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(
      attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }),
      cfg,
      NOW,
    );
    expect(s.snapshot(cfg, NOW + 5_000).workers[0]?.cooldownRemainingMs).toBe(895_000);

    // 出口配置错误(retry.ts 里 blameWorker: false)
    s.record(
      attempt({ workerId: "w1", failure: "bad_request", blameWorker: false }),
      cfg,
      NOW + 5_000,
    );
    const after = s.snapshot(cfg, NOW + 5_000).workers[0];
    expect(after?.cooldownRemainingMs).toBe(895_000);
    expect(after?.ready).toBe(false);
    // 计数仍然被清零 —— 那是不变量 #4 原本的目的。
    expect(after?.consecutiveFails).toBe(0);
  });

  it("**真正的成功**才解除冷却", () => {
    /*
     * 与上一条成对。一次成功的请求是上游用行为否定了先前那次失败的判断,
     * 所以解除冷却是对的 —— 而"不归咎"只是说这次失败不该算在它头上。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(
      attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }),
      cfg,
      NOW,
    );
    s.record(attempt({ workerId: "w1" }), cfg, NOW + 5_000);
    expect(s.snapshot(cfg, NOW + 5_000).workers[0]).toMatchObject({
      ready: true,
      cooldownRemainingMs: 0,
    });
  });

  it("`unknown` 不冷却时也不得让失败计数膨胀", () => {
    /*
     * 第四处纪律 #4 分叉(第五轮审核发现)。`shouldCooldown()` 把
     * `bad_request` 与 `unknown` **同等对待**(都不冷却),而 `record` 的
     * 分支条件只看 `blameWorker` —— 两份判断不是同一个真相。
     *
     * `unknown` 的 `blameWorker` 为 true(`retry.ts` 只对出口配置错误置 false),
     * 于是它走 `markFailure`:计数 +1 而冷却为 null。实测后果:
     *
     * ```
     * 5x bad_request 后一次 transport 冷却 = 2000 ms
     * 5x unknown     后一次 transport 冷却 = 64000 ms  (上限 120000)
     * ```
     *
     * 也就是 `markSuccess` 注释声称已防住的那个问题,只是入口从
     * `bad_request` 换成了 `unknown`。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    for (let i = 0; i < 5; i += 1) {
      s.record(attempt({ workerId: "w1", failure: "unknown", blameWorker: true }), cfg, NOW);
    }
    expect(s.snapshot(cfg, NOW).workers[0]).toMatchObject({
      consecutiveFails: 0,
      ready: true,
    });

    // 随后一次真实故障必须从基准值起跳,而不是 2^5 倍。
    s.record(attempt({ workerId: "w1", failure: "transport", blameWorker: true }), cfg, NOW);
    expect(s.snapshot(cfg, NOW).workers[0]?.cooldownRemainingMs).toBe(
      cfg.routing.cooldown.transportBaseMs,
    );
  });

  it("出口配置错误不得拖慢后续真实故障的恢复", () => {
    /*
     * 上一条的行为后果。出口配置错误(`egressSetup`)在 `retry.ts` 里
     * `blameWorker: false`,连发多次后下一次真实传输失败必须仍从基准值起跳。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    for (let i = 0; i < 5; i += 1) {
      s.record(attempt({ workerId: "w1", failure: "bad_request", blameWorker: false }), cfg, NOW);
    }
    s.record(attempt({ workerId: "w1", failure: "transport", blameWorker: true }), cfg, NOW);
    expect(s.snapshot(cfg, NOW).workers[0]?.cooldownRemainingMs).toBe(
      cfg.routing.cooldown.transportBaseMs,
    );
  });

  it("坏请求重复发很多次也不会让任何 Worker 消失", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    for (let i = 0; i < 100; i += 1) {
      s.record(attempt({ workerId: "w1", failure: "bad_request", blameWorker: false }), cfg, NOW);
      s.record(attempt({ workerId: "w2", failure: "bad_request", blameWorker: false }), cfg, NOW);
    }
    expect(s.counts(cfg, NOW)).toEqual({ ready: 2, total: 2 });
  });

  it("失败且 blameWorker 为 true → 按类别冷却", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(
      attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "600" }),
      cfg,
      NOW,
    );
    expect(s.snapshot(cfg, NOW).workers[0]).toMatchObject({
      ready: false,
      cooldownRemainingMs: 600_000,
      lastFailure: "rate_limit",
    });
  });

  it("逐次记账:一条链里三个 Worker 各自得到自己的处置", () => {
    /*
     * 只记最后一个会让前两个的故障消失,于是下一条请求又把它们重试一遍 ——
     * 冷却完全不起作用,而症状是"限流了还在打"。
     */
    const cfg = config(["w1", "w2", "w3"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }), cfg, NOW);
    s.record(attempt({ workerId: "w2", failure: "transport", blameWorker: true }), cfg, NOW);
    s.record(attempt({ workerId: "w3" }), cfg, NOW);

    const snap = s.snapshot(cfg, NOW).workers;
    expect(snap.map((w) => [w.id, w.ready])).toEqual([
      ["w1", false],
      ["w2", false],
      ["w3", true],
    ]);
  });

  it("不存在的 Worker 记账不抛错", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    expect(() =>
      s.record(attempt({ workerId: "ghost", failure: "auth", blameWorker: true }), cfg, NOW),
    ).not.toThrow();
  });
});

describe("settleStream:不变量 #3", () => {
  const sessionHash = digestOf("ses-settle");

  it("2xx 且完整 → 学习指纹", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.settleStream({
      workerId: "w2",
      sessionHash,
      blobHashes: ["b1", "b2"],
      status: 200,
      staleHit: false,
      complete: true,
      now: NOW,
    });

    // 新会话 + 同一批指纹 → 应当被提示到 w2。
    const result = plan(s, cfg, NOW, digestOf("brand-new"), ["b1", "b2"]);
    expect(result.targets[0]?.workerId).toBe("w2");
    expect(result.reason).toBe("blob_hint");
  });

  it("检出失效推理 → 解绑会话 + 忘掉指纹", () => {
    /*
     * 留着会让下一轮回到同一个必败 Worker:失效的推理指纹一直把会话
     * 钉在错的 Worker 上,每一轮都失败,而失败原因看起来来自上游。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    // 先建立绑定与指纹。
    plan(s, cfg, NOW, sessionHash);
    s.settleStream({
      workerId: "w1",
      sessionHash,
      blobHashes: ["b1"],
      status: 200,
      staleHit: false,
      complete: true,
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual({ sessions: 1, blobs: 1 });

    s.settleStream({
      workerId: "w1",
      sessionHash,
      blobHashes: ["b1"],
      status: 200,
      staleHit: true,
      complete: true,
      now: NOW + 1000,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual({ sessions: 0, blobs: 0 });
  });

  it("失效推理即便带着 200 也要处置 —— SSE 里可以夹着拒绝", () => {
    /*
     * 这正是不变量 #3 的由来:只看状态码会整条漏掉。
     */
    const cfg = config(["w1"]);
    const s = scheduler();
    plan(s, cfg, NOW, sessionHash);
    s.settleStream({
      workerId: "w1",
      sessionHash,
      blobHashes: [],
      status: 200,
      staleHit: true,
      complete: true,
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity.sessions).toBe(0);
  });

  it("不完整(断流/客户端取消)→ 既不学也不忘", () => {
    /*
     * 学了可能把一个其实会拒的 Worker 记成正确答案;忘了则白丢一个可能
     * 正确的绑定 —— 客户端按 ESC 中断生成属于这一类,而那与推理是否有效
     * 毫无关系。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    plan(s, cfg, NOW, sessionHash);
    const before = s.snapshot(cfg, NOW).affinity;

    s.settleStream({
      workerId: "w1",
      sessionHash,
      blobHashes: ["b1"],
      status: 200,
      staleHit: false,
      complete: false,
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual(before);
  });

  it("非 2xx 不学习(但也不误伤绑定)", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    plan(s, cfg, NOW, sessionHash);
    s.settleStream({
      workerId: "w1",
      sessionHash,
      blobHashes: ["b1"],
      status: 429,
      staleHit: false,
      complete: true,
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual({ sessions: 1, blobs: 0 });
  });

  it("没有指纹时 2xx 不产生任何条目", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    s.settleStream({
      workerId: "w1",
      sessionHash: null,
      blobHashes: [],
      status: 200,
      staleHit: false,
      complete: true,
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual({ sessions: 0, blobs: 0 });
  });

  it("失效推理但没有会话哈希时只忘指纹,不抛错", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    s.settleStream({
      workerId: "w1",
      sessionHash: null,
      blobHashes: ["b1"],
      status: 200,
      staleHit: false,
      complete: true,
      now: NOW,
    });
    expect(() =>
      s.settleStream({
        workerId: "w1",
        sessionHash: null,
        blobHashes: ["b1"],
        status: 200,
        staleHit: true,
        complete: true,
        now: NOW,
      }),
    ).not.toThrow();
    expect(s.snapshot(cfg, NOW).affinity.blobs).toBe(0);
  });
});

describe("settleBuffered", () => {
  it("从响应文本自己判定失效推理", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    const sessionHash = digestOf("ses-buffered");
    plan(s, cfg, NOW, sessionHash);

    s.settleBuffered({
      workerId: "w1",
      sessionHash,
      blobHashes: ["b1"],
      status: 400,
      bodyText: '{"error":{"message":"reasoning block was not issued to this caller"}}',
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity).toEqual({ sessions: 0, blobs: 0 });
  });

  it("正常响应文本照常学习", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    s.settleBuffered({
      workerId: "w1",
      sessionHash: null,
      blobHashes: ["b1"],
      status: 200,
      bodyText: '{"choices":[{"message":{"content":"你好"}}]}',
      now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity.blobs).toBe(1);
  });
});

describe("跨请求的端到端行为", () => {
  it("限流 → 换人 → 恢复后回到原顺序", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    expect(plan(s, cfg).targets[0]?.workerId).toBe("w1");
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "60" }), cfg, NOW);
    expect(plan(s, cfg, NOW + 1000).targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(plan(s, cfg, NOW + 60_000).targets.map((t) => t.workerId)).toEqual(["w1", "w2"]);
  });

  it("粘滞 + 冷却:绑定的 Worker 被限流后下一轮换人并改绑", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    const sessionHash = digestOf("ses-e2e");

    expect(plan(s, cfg, NOW, sessionHash).targets[0]?.workerId).toBe("w1");
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }), cfg, NOW);

    const after = plan(s, cfg, NOW + 1000, sessionHash);
    expect(after.targets[0]?.workerId).toBe("w2");
    // 改绑之后即便 w1 恢复,这条会话继续留在 w2。
    expect(plan(s, cfg, NOW + 999_999, sessionHash).targets[0]?.workerId).toBe("w2");
  });

  it("全员限流后只给最早恢复的一个", () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w1", failure: "rate_limit", blameWorker: true, retryAfter: "900" }), cfg, NOW);
    s.record(attempt({ workerId: "w2", failure: "rate_limit", blameWorker: true, retryAfter: "60" }), cfg, NOW);

    const result = plan(s, cfg, NOW + 1000);
    expect(result.targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(result.reason).toBe("all_cooling");
  });
});

describe("rebind:绑定实际承接者", () => {
  const sessionHash = digestOf("ses-rebind");

  it("把会话改绑到链里真正成功的那个 Worker", () => {
    /*
     * `plan` 绑的是候选链首位,而重试链可能往后走。集成测试查出的缺陷:
     * 一条「w1 拿到 429 → w2 成功」的链里签发推理块的是 w2,若绑定仍停在 w1,
     * 等 w1 冷却结束下一轮就回到它 —— 而客户端回放的是 w2 签发的推理块,
     * 上游必拒。症状是「对话隔一会儿报一次错」,且只在限流之后出现。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    expect(plan(s, cfg, NOW, sessionHash).targets[0]?.workerId).toBe("w1");

    s.rebind(sessionHash, "w2", NOW);
    expect(plan(s, cfg, NOW + 1000, sessionHash).targets[0]?.workerId).toBe("w2");
  });

  it("没有会话哈希时是空操作", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    s.rebind(null, "w1", NOW);
    expect(s.snapshot(cfg, NOW).affinity.sessions).toBe(0);
  });

  it("绑不存在的 Worker 被拒 —— 否则下一轮会查一个查不到的 id", () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    plan(s, cfg, NOW, sessionHash);
    s.rebind(sessionHash, "ghost", NOW);
    expect(plan(s, cfg, NOW + 1000, sessionHash).targets[0]?.workerId).toBe("w1");
  });

  it("改绑也刷新 TTL", () => {
    const cfg = config(["w1", "w2"], { affinityTtlMs: 60_000 });
    const s = scheduler();
    plan(s, cfg, NOW, sessionHash);
    s.rebind(sessionHash, "w2", NOW + 50_000);
    // 从改绑时刻起算,再过 59 秒仍在。
    expect(plan(s, cfg, NOW + 109_000, sessionHash).targets[0]?.workerId).toBe("w2");
  });
});

describe("counts / snapshot / prune", () => {
  it("counts 供 poolHealth 用", () => {
    const cfg = config(["w1", "w2", "w3"]);
    const s = scheduler();
    s.record(attempt({ workerId: "w2", failure: "auth", blameWorker: true }), cfg, NOW);
    expect(s.counts(cfg, NOW)).toEqual({ ready: 2, total: 3 });
  });

  it("snapshot 不含 apiKey", () => {
    const cfg = config(["w1"]);
    const json = JSON.stringify(scheduler().snapshot(cfg, NOW));
    expect(json).not.toContain("fake-key-w1-not-real");
  });

  it("prune 清掉过期与指向已删除 Worker 的亲和条目", () => {
    const cfg = config(["w1", "w2"], { affinityTtlMs: 60_000 });
    const s = scheduler();
    plan(s, cfg, NOW, digestOf("s1"));
    expect(s.snapshot(cfg, NOW).affinity.sessions).toBe(1);

    s.prune(cfg, NOW + 60_001);
    expect(s.snapshot(cfg, NOW).affinity.sessions).toBe(0);
  });

  it("prune 在 Worker 被删掉后清掉指向它的绑定", () => {
    const s = scheduler();
    const withBoth = config(["w1", "w2"]);
    plan(s, withBoth, NOW, digestOf("s1"));

    const onlyW2 = config(["w2"]);
    s.prune(onlyW2, NOW);
    expect(s.snapshot(onlyW2, NOW).affinity.sessions).toBe(0);
  });
});
