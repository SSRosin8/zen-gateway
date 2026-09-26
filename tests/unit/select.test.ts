import { describe, expect, it } from "vitest";
import {
  describeNoWorker,
  select,
  sessionHashFrom,
  usableTargets,
} from "../../src/core/routing/select.ts";
import { WorkerPool } from "../../src/core/routing/workerPool.ts";
import { AffinityMap, digestOf } from "../../src/core/routing/affinity.ts";
import { ConfigSchema, type Config, type RoutingStrategy } from "../../src/shared/schema.ts";

/**
 * Worker 选择。时钟与抖动全部注入。
 */

const NOW = 1_800_000_000_000;
/** 亲和 TTL —— 与 schema 默认值一致(容量淘汰要据它判断什么算过期)。 */
const TTL = 3_600_000;

type WorkerSpec = {
  id: string;
  kind?: "anonymous" | "authenticated";
  apiKey?: string;
  enabled?: boolean;
};

function config(
  workers: WorkerSpec[],
  over: { strategy?: RoutingStrategy; affinityTtlMs?: number } = {},
): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "unit-test-relay-token-x" },
    routing: {
      ...(over.strategy !== undefined ? { strategy: over.strategy } : {}),
      ...(over.affinityTtlMs !== undefined ? { affinityTtlMs: over.affinityTtlMs } : {}),
    },
    workers: workers.map((w) => ({
      id: w.id,
      name: "",
      kind: w.kind ?? "authenticated",
      apiKey: w.apiKey ?? `fake-key-${w.id}-not-real`,
      enabled: w.enabled ?? true,
      proxyId: null,
    })),
  });
}

/** 便捷:建池 + 选一次,返回候选 id 序列。 */
function ids(cfg: Config, now = NOW): string[] {
  return select({ pool: new WorkerPool(cfg), config: cfg, now }).targets.map((t) => t.workerId);
}

describe("空池", () => {
  it("没有可用 Worker 时候选为空,reason 为 empty", () => {
    const cfg = config([{ id: "w1", enabled: false }]);
    const result = select({ pool: new WorkerPool(cfg), config: cfg, now: NOW });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe("empty");
  });
});

describe("基础排序", () => {
  it("全部就绪时按配置顺序排全部候选", () => {
    expect(ids(config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]))).toEqual(["w1", "w2", "w3"]);
  });

  it("候选携带 key 与出口 —— 重试链靠它发请求", () => {
    const cfg = config([{ id: "w1" }]);
    const target = select({ pool: new WorkerPool(cfg), config: cfg, now: NOW }).targets[0];
    expect(target).toEqual({ workerId: "w1", apiKey: "fake-key-w1-not-real", proxyId: null });
  });
});

describe("冷却中的 Worker 不进候选", () => {
  it("有就绪的时候,冷却中的**完全**不排进候选", () => {
    /*
     * 这是本文件最要紧的一条判断,而且直觉容易反过来(「排在尾巴上当备选」)。
     *
     * 排进尾巴意味着"有健康 Worker 时也可能打到冷却中的" —— 而冷却存在的
     * 理由正是别再打它。429 尤其:上游刚说了 `Retry-After: 900`,
     * 我们在 2 秒后又发一次只会换来更长的封禁。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w2", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });

    const result = select({ pool, config: cfg, now: NOW });
    expect(result.targets.map((t) => t.workerId)).toEqual(["w1", "w3"]);
  });

  it("冷却到期后重新进候选", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0 });

    expect(select({ pool, config: cfg, now: NOW }).targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(
      select({ pool, config: cfg, now: NOW + 60_000 }).targets.map((t) => t.workerId),
    ).toEqual(["w1", "w2"]);
  });
});

describe("全员冷却", () => {
  it("只给**最早恢复**的那一个,而不是轮转槽位", () => {
    /*
     * 轮转槽位会在全员冷却时把请求散到恢复最晚的那个,于是重试互相错过 ——
     * 每次都挑一个还要等很久的,而最接近恢复的那个反而轮不到。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    pool.markFailure({ workerId: "w2", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0 });
    pool.markFailure({ workerId: "w3", kind: "rate_limit", retryAfter: "300", config: cfg, now: NOW, jitter: 0 });

    const result = select({ pool, config: cfg, now: NOW });
    expect(result.targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(result.reason).toBe("all_cooling");
  });

  it("只给一个,不把其余冷却中的排上", () => {
    /*
     * 给一个的意义:让客户端拿到一次**真实的上游错误**(而不是网关自造的
     * 503)。多给几个只是把同一个已知的失败重复几次,还多花几次上游调用。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    for (const id of ["w1", "w2", "w3"]) {
      pool.markFailure({ workerId: id, kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    }
    expect(select({ pool, config: cfg, now: NOW }).targets).toHaveLength(1);
  });
});

describe("策略排序", () => {
  it("authenticated_first 把登录态排前,但不丢掉其他", () => {
    /*
     * 匿名 Worker 即使没有 key 也能进入候选池；策略按 kind 排序，
     * 与认证凭证是否存在是两件事。
     */
    const cfg = config(
      [
        { id: "anon", kind: "anonymous", apiKey: "" },
        { id: "auth1" },
        { id: "auth2" },
      ],
      { strategy: "authenticated_first" },
    );
    expect(ids(cfg)).toEqual(["auth1", "auth2", "anon"]);
  });

  it("anonymous_first 把匿名排前", () => {
    const cfg = config(
      [
        { id: "auth1" },
        { id: "anon", kind: "anonymous", apiKey: "" },
      ],
      { strategy: "anonymous_first" },
    );
    expect(ids(cfg)).toEqual(["anon", "auth1"]);
  });

  it("mixed 完全按配置顺序", () => {
    const cfg = config(
      [
        { id: "auth1" },
        { id: "anon", kind: "anonymous", apiKey: "" },
        { id: "auth2" },
      ],
      { strategy: "mixed" },
    );
    expect(ids(cfg)).toEqual(["auth1", "anon", "auth2"]);
  });

  it("同类别内部保持配置顺序 —— 排序必须稳定", () => {
    /*
     * `sort` 自 ES2019 起保证稳定,所以用户手排的优先级不会被策略打乱。
     * 这条断言存在是因为"策略排序"与"用户排序"是两个都要满足的需求,
     * 而不稳定的排序会让后者时有时无。
     */
    const cfg = config(
      [{ id: "wc" }, { id: "wa" }, { id: "wb" }],
      { strategy: "authenticated_first" },
    );
    expect(ids(cfg)).toEqual(["wc", "wa", "wb"]);
  });

  it("默认策略是 anonymous_first,且它**真的生效**", () => {
    /*
     * 匿名身份即使没有 key 也与认证身份分属不同排序类别；
     * 同一份 Worker 列表只改策略就会改变顺序。
     */
    const workers = [
      { id: "auth1" },
      { id: "anon", kind: "anonymous" as const, apiKey: "" },
    ];
    const byDefault = config(workers);
    expect(byDefault.routing.strategy).toBe("anonymous_first");
    // 默认策略把匿名排前 —— 不是"等价于配置顺序"。
    expect(ids(byDefault)).toEqual(["anon", "auth1"]);
    expect(ids(config(workers, { strategy: "mixed" }))).toEqual(["auth1", "anon"]);
  });

  it("全是 authenticated 时三个策略产出同一顺序", () => {
    /*
     * 上一条的边界:实践中用户只会配 authenticated(免 key 通道已关闭),
     * 那种配置下策略确实没有可见效果 —— 但那是**输入集**的性质,
     * 不是代码分支的性质。两者的区别是上一条要钉住的东西。
     */
    const workers = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];
    for (const strategy of ["anonymous_first", "authenticated_first", "mixed"] as const) {
      expect(ids(config(workers, { strategy }))).toEqual(["w1", "w2", "w3"]);
    }
  });
});

describe("会话粘滞", () => {
  const sessionHash = digestOf("ses-unit-1");

  it("同一会话连续命中同一个 Worker", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    const ctx = { map, sessionHash, blobHashes: [] as string[] };

    const first = select({ pool, config: cfg, now: NOW, affinity: ctx });
    expect(first.targets[0]?.workerId).toBe("w1");

    // 第二次必须还是它 —— 即便 w2/w3 同样就绪。
    const second = select({ pool, config: cfg, now: NOW + 1000, affinity: ctx });
    expect(second.targets[0]?.workerId).toBe("w1");
    expect(second.reason).toBe("sticky");
    expect(second.stickyWorkerId).toBe("w1");
  });

  it("严格粘滞:策略偏好**不**抢占健康的绑定", () => {
    /*
     * 这是规划点名的"严格粘滞"。中途换 Worker 会让客户端回放的加密推理块
     * 被上游拒掉 —— 表现为对话中途突然报错,而用户什么都没改。
     *
     * 所以先用 mixed 绑到一个 anon,再把策略改成 authenticated_first:
     * 绑定必须赢。
     */
    const anon = { id: "anon", kind: "anonymous" as const, apiKey: "" };
    const mixed = config([anon, { id: "auth1" }], { strategy: "mixed" });
    const pool = new WorkerPool(mixed);
    const map = new AffinityMap();
    const ctx = { map, sessionHash, blobHashes: [] as string[] };

    expect(select({ pool, config: mixed, now: NOW, affinity: ctx }).targets[0]?.workerId).toBe("anon");

    const preferAuth = config([anon, { id: "auth1" }], { strategy: "authenticated_first" });
    pool.sync(preferAuth);
    const after = select({ pool, config: preferAuth, now: NOW + 1000, affinity: ctx });
    expect(after.targets[0]?.workerId).toBe("anon");
    expect(after.reason).toBe("sticky");
  });

  it("粘滞的 Worker 仍在候选首位,其余按策略跟在后面且不重复", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.bindSession(sessionHash, "w3", NOW, TTL);

    const result = select({
      pool,
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash, blobHashes: [] },
    });
    expect(result.targets.map((t) => t.workerId)).toEqual(["w3", "w1", "w2"]);
  });

  it("绑定的 Worker 进入冷却时放弃粘滞并重挑", () => {
    /*
     * 等它恢复是错的:冷却可能长达 15 分钟,而客户端只会看到网关卡住。
     * 代价是这一轮的推理连续性丢失(上游会拒掉回放的推理块),但那是
     * **上游的**错误,客户端能看到并开一个新 turn —— 好于我们自己把请求挂住。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.bindSession(sessionHash, "w1", NOW, TTL);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });

    const result = select({
      pool,
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash, blobHashes: [] },
    });
    expect(result.targets[0]?.workerId).toBe("w2");
    expect(result.reason).toBe("strategy");
    // 旧绑定被清掉,并改绑到新选中的那个。
    expect(map.lookupSession(sessionHash, NOW, cfg.routing.affinityTtlMs, () => true)).toBe("w2");
  });

  it("绑定的 Worker 已从配置删除时重挑", () => {
    const cfg = config([{ id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.bindSession(sessionHash, "deleted", NOW, TTL);

    expect(
      select({ pool, config: cfg, now: NOW, affinity: { map, sessionHash, blobHashes: [] } })
        .targets[0]?.workerId,
    ).toBe("w2");
  });

  it("TTL 是**滑动**的:活跃会话不被强制解绑", () => {
    /*
     * 不是"固定 TTL"(从首次绑定起算,到点必须换 Worker)—— 滑动语义才是对的。
     *
     * 固定 TTL 会在一条**正在进行**的长对话中途强制换 Worker,而那恰好是
     * 粘滞要避免的事:换了 Worker,客户端回放的加密推理块就会被上游拒掉,
     * 表现为对话到某个时刻突然开始报错。TTL 的目的是清理**已结束**的会话
     * (腾容量、不让老绑定钉住未来的会话),活跃会话不在其列。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }], { affinityTtlMs: 60_000 });
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    const ctx = { map, sessionHash, blobHashes: [] as string[] };
    map.bindSession(sessionHash, "w2", NOW, TTL);

    // 每隔 59 秒来一次:跨越 10 倍 TTL,绑定始终不掉。
    let at = NOW;
    for (let i = 0; i < 10; i += 1) {
      at += 59_000;
      expect(select({ pool, config: cfg, now: at, affinity: ctx }).targets[0]?.workerId).toBe("w2");
    }
  });

  it("闲置超过 TTL 后解绑重挑", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }], { affinityTtlMs: 60_000 });
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.bindSession(sessionHash, "w2", NOW, TTL);

    // 边界:恰好 TTL 仍命中。
    expect(
      select({ pool, config: cfg, now: NOW + 60_000, affinity: { map, sessionHash, blobHashes: [] } })
        .targets[0]?.workerId,
    ).toBe("w2");

    // 重新绑定(上一步刷新了时间),这次真的闲置过头。
    const fresh = new AffinityMap();
    fresh.bindSession(sessionHash, "w2", NOW, TTL);
    expect(
      select({ pool, config: cfg, now: NOW + 60_001, affinity: { map: fresh, sessionHash, blobHashes: [] } })
        .targets[0]?.workerId,
    ).toBe("w1");
  });

  it("没有会话标识时不绑定,也不报 sticky", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const map = new AffinityMap();
    const result = select({
      pool: new WorkerPool(cfg),
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash: null, blobHashes: [] },
    });
    expect(result.reason).toBe("strategy");
    expect(map.sizes().sessions).toBe(0);
  });

  it("绑定发生在**选择时**,不等成功 —— 并发的同会话请求要落到同一个", () => {
    /*
     * 若等成功才绑,两个同时进来的 turn 会各自挑一个,而它们回放的是同一批
     * 推理块 —— 其中一个必定被上游拒。绑定本身是自纠正的:被绑的 Worker
     * 一旦进入冷却,下一轮 `lookupSession` 就查不到它。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    const ctx = { map, sessionHash, blobHashes: [] as string[] };

    const a = select({ pool, config: cfg, now: NOW, affinity: ctx });
    const b = select({ pool, config: cfg, now: NOW, affinity: ctx });
    expect(a.targets[0]?.workerId).toBe(b.targets[0]?.workerId);
  });

  it("全员冷却时**不动**会话绑定", () => {
    /*
     * 不能断言相反的行为(「全员冷却时也落绑定」),理由
     * 「否则下一轮又换一个」**不成立**:
     * `all_cooling` 选的是"最早恢复的那个",而那是个确定性函数 ——
     * 同一组冷却状态下每次都选中同一个,不存在"来回换"。
     *
     * 而无条件 bind 的代价很实在:一次短暂的全员冷却窗口就能把会话绑定
     * **永久**迁走。见下一条。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    for (const id of ["w1", "w2"]) {
      pool.markFailure({ workerId: id, kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    }
    const result = select({ pool, config: cfg, now: NOW, affinity: { map, sessionHash, blobHashes: [] } });
    expect(result.reason).toBe("all_cooling");
    // 本来没有绑定 → 不凭空造一条。
    expect(map.sizes().sessions).toBe(0);
  });

  it("全员冷却窗口**不得**把已有绑定迁走", () => {
    /*
     * 与「绑定停在候选链首位」是镜像形态。无条件 bind 时实测:
     *
     * ```
     * 轮1 链: [w1, w2]                      绑定 w1(w1 签发了推理块)
     * 轮2 链: [w2]  reason = all_cooling    → 改绑 w2
     * 轮3 链: [w2, w1] reason = sticky      ← 指纹真相是 w1
     * ```
     *
     * 指纹映射保留了正确答案 w1,但指纹提示只在 `sticky === null` 时才查 ——
     * 会话绑定已命中,那份正确信息永远读不到。症状:客户端回放 w1 签发的
     * 推理块,我们把请求钉到 w2,上游必拒。「对话隔一会儿报一次错,
     * 且只在限流之后出现」。
     *
     * 正确行为:全员冷却这一轮不动绑定。若这一轮**成功**了,
     * `relay.ts` 的 `rebind()` 会把绑定落到实际承接者身上 —— 那才是
     * 知道"推理块是谁签发的"的时机。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    const ctx = { map, sessionHash, blobHashes: [] as string[] };

    // 轮 1:绑到 w1。
    expect(select({ pool, config: cfg, now: NOW, affinity: ctx }).targets[0]?.workerId).toBe("w1");

    // 两个都冷却,w2 恢复更早。
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    pool.markFailure({ workerId: "w2", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0 });

    // 轮 2:只能打 w2(最早恢复),但绑定不得改。
    const r2 = select({ pool, config: cfg, now: NOW + 1_000, affinity: ctx });
    expect(r2.targets.map((t) => t.workerId)).toEqual(["w2"]);
    expect(r2.reason).toBe("all_cooling");

    // 轮 3:冷却都过去了,必须回到 w1 —— 它才是签发推理块的那个。
    const r3 = select({ pool, config: cfg, now: NOW + 999_999, affinity: ctx });
    expect(r3.targets[0]?.workerId).toBe("w1");
    expect(r3.reason).toBe("sticky");
  });

  it("绑定的 Worker 在冷却但**有其他就绪的**时,仍然换人", () => {
    /*
     * 与上一条的边界区分:这里不是全员冷却,所以放弃粘滞、用就绪的那个。
     * 等它恢复是错的 —— 冷却可能长达 15 分钟,客户端只会看到网关卡住。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.bindSession(sessionHash, "w1", NOW, TTL);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });

    const result = select({ pool, config: cfg, now: NOW, affinity: { map, sessionHash, blobHashes: [] } });
    expect(result.targets[0]?.workerId).toBe("w2");
    expect(result.reason).toBe("strategy");
  });
});

describe("推理指纹提示", () => {
  it("未绑定会话但指纹已知时用提示的 Worker", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }, { id: "w3" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.learnBlobs(["b1", "b2"], "w3", NOW, TTL);

    const result = select({
      pool,
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash: digestOf("new-session"), blobHashes: ["b1", "b2"] },
    });
    expect(result.targets[0]?.workerId).toBe("w3");
    expect(result.reason).toBe("blob_hint");
  });

  it("会话绑定优先于指纹提示", () => {
    /*
     * 会话绑定是**直接**证据(这条会话上一轮就用了它);指纹提示是间接的
     * (这批推理块曾被它服务过)。两者冲突时前者更可信。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    const sessionHash = digestOf("ses-both");
    map.bindSession(sessionHash, "w1", NOW, TTL);
    map.learnBlobs(["b1"], "w2", NOW, TTL);

    const result = select({
      pool,
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash, blobHashes: ["b1"] },
    });
    expect(result.targets[0]?.workerId).toBe("w1");
    expect(result.reason).toBe("sticky");
  });

  it("提示的 Worker 在冷却时退回策略排序", () => {
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    const pool = new WorkerPool(cfg);
    const map = new AffinityMap();
    map.learnBlobs(["b1"], "w2", NOW, TTL);
    pool.markFailure({ workerId: "w2", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });

    const result = select({
      pool,
      config: cfg,
      now: NOW,
      affinity: { map, sessionHash: digestOf("s"), blobHashes: ["b1"] },
    });
    expect(result.targets[0]?.workerId).toBe("w1");
    expect(result.reason).toBe("strategy");
  });
});

describe("sessionHashFrom", () => {
  it("体内的会话指针优先于头", () => {
    /*
     * 体内标识(Responses 面的 `previous_response_id`)是协议自己的语义,
     * 比客户端的自定义头更权威。
     */
    expect(sessionHashFrom({ bodyKey: "resp_abc", headerValue: "ses_xyz" })).toBe(
      digestOf("resp_abc"),
    );
  });

  it("没有体内标识时用头", () => {
    expect(sessionHashFrom({ bodyKey: undefined, headerValue: "ses_xyz" })).toBe(
      digestOf("ses_xyz"),
    );
  });

  it("两者都没有时返回 null —— 粘滞自然失效", () => {
    expect(sessionHashFrom({ bodyKey: undefined, headerValue: undefined })).toBeNull();
    expect(sessionHashFrom({ bodyKey: "", headerValue: "" })).toBeNull();
    expect(sessionHashFrom({ bodyKey: "  ", headerValue: "  " })).toBeNull();
  });

  it("产出的一定是 64 位小写十六进制 —— 绝不是会话原值", () => {
    const hash = sessionHashFrom({ bodyKey: undefined, headerValue: "ses_sensitive_value" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("sensitive");
  });
});

describe("usableTargets(供 /v1/models)", () => {
  it("只给可用的,按配置顺序", () => {
    const cfg = config([{ id: "w1" }, { id: "w2", enabled: false }, { id: "w3" }]);
    expect(usableTargets(cfg).map((t) => t.workerId)).toEqual(["w1", "w3"]);
  });

  it("不读任何调度状态 —— 目录查询不受冷却影响", () => {
    /*
     * 刻意不共享状态:让一次目录查询失败把 Worker 打进冷却,等于**一个只读
     * 查询改变了转发的候选顺序**,而用户完全看不出这两件事有关系。
     * 反过来也一样 —— 转发把 Worker 全打进冷却后,目录查询仍该能工作。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({ workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0 });
    expect(usableTargets(cfg).map((t) => t.workerId)).toEqual(["w1"]);
  });
});

describe("describeNoWorker", () => {
  it("区分三种「没有可用 Worker」", () => {
    expect(describeNoWorker(config([]))).toContain("尚未配置");
    expect(describeNoWorker(config([{ id: "w1", enabled: false }]))).toContain("停用");
    expect(
      describeNoWorker(config([{ id: "w1", kind: "anonymous", apiKey: "" }])),
    ).toContain("API key");
  });
});
