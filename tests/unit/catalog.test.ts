import { describe, expect, it } from "vitest";
import { Response as UndiciResponse } from "undici";
import {
  ModelCatalog,
  catalogIdentityOf,
  isModelEntry,
  parseCatalog,
  slotOf,
} from "../../src/core/models/catalog.ts";
import type { UpstreamDeps } from "../../src/core/upstream/fetch.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { DispatcherPool } from "../../src/core/proxy/dispatcher.ts";
import { SelectorLockRegistry } from "../../src/core/proxy/selectorLock.ts";

/**
 * 在架目录缓存。
 *
 * 本文件最要紧的一组断言是**「拉取失败／响应可疑时保留旧缓存」** ——
 * 目录为空等于免费集为空等于网关拒绝一切,所以采纳一份坏目录比拉取失败更糟。
 */

const TTL = 30 * 60 * 1000;

function config(over: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "catalog-test-token-not-real" },
    ...over,
  });
}

function workerConfig(ids: string[]): Config {
  return config({
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

/** 上游目录响应。 */
function catalogResponse(ids: string[], status = 200): UndiciResponse {
  const data = ids.map((id) => ({ id, object: "model", created: 1, owned_by: "opencode" }));
  return new UndiciResponse(JSON.stringify({ object: "list", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 按脚本依次应答的假 deps。 */
function fakeDeps(script: Array<UndiciResponse | Error>): {
  upstreamOf: (config: Config) => UpstreamDeps;
  calls: () => number;
  keys: () => string[];
  /**
   * 每次请求实际用的**出口** —— `mode:none` 表示本机直连,`direct:<id>` 表示
   * 经那个代理。目录请求的出口隔离只能在这里观察:`proxyId` 唯一能产生
   * 可观察后果的地方就是 `DispatcherPool.get` 收到的 target。
   */
  targets: () => string[];
} {
  let i = 0;
  const keys: string[] = [];
  const targets: string[] = [];
  const pool = new DispatcherPool({ headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
  /*
   * 包一层记录 target。刻意**不替换** `DispatcherPool` —— 它自己的缓存键逻辑
   * (按 Clash 节点名缓存)是不变量 #7,换成假实现就测不到真实的 target 构造了。
   */
  const spyPool = {
    get(target: Parameters<DispatcherPool["get"]>[0]) {
      targets.push(target.mode === "none" ? "none" : `${target.mode}:${target.proxy.id}`);
      return pool.get(target);
    },
  } as unknown as DispatcherPool;
  return {
    calls: () => i,
    keys: () => keys,
    targets: () => targets,
    upstreamOf: (cfg: Config): UpstreamDeps => ({
      config: cfg,
      dispatchers: spyPool,
      locks: new SelectorLockRegistry(),
      controllerFor: () => null,
      fetchImpl: (async (_url: string, init: { headers?: Record<string, string> }) => {
        keys.push(init.headers?.["authorization"] ?? "(无)");
        const item = script[i];
        i += 1;
        if (item === undefined) throw new Error("脚本用尽:被多调用了一次");
        if (item instanceof Error) throw item;
        return item;
      }) as unknown as NonNullable<UpstreamDeps["fetchImpl"]>,
    }),
  };
}

describe("parseCatalog", () => {
  it("正常目录", () => {
    const snap = parseCatalog({ data: [{ id: "a" }, { id: "b" }] }, "keyed", 1000);
    expect(snap?.ids).toEqual(new Set(["a", "b"]));
    expect(snap?.entries).toHaveLength(2);
    expect(snap?.fetchedAt).toBe(1000);
    expect(snap?.slot).toBe("keyed");
  });

  it("上游条目的其余字段**原样保留**", () => {
    // 客户端可能依赖 created/owned_by,重建对象会丢掉我们没预料到的字段。
    const snap = parseCatalog({ data: [{ id: "a", created: 7, custom: "x" }] }, "keyed", 0);
    expect(snap?.entries[0]).toEqual({ id: "a", created: 7, custom: "x" });
  });

  it("**空 data 不可采纳** —— 这是整个缓存的要点", () => {
    /*
     * 一个 200 带空 data 会把免费集清空,于是网关拒绝一切合法请求。
     * 这比一次请求失败严重得多 —— 失败时我们还留着旧目录。
     */
    expect(parseCatalog({ data: [] }, "keyed", 0)).toBeNull();
  });

  it("只有非法条目时也算空", () => {
    // 过滤掉 id 不是字符串的之后一条不剩 —— 与空 data 同样处置。
    expect(parseCatalog({ data: [{ noId: 1 }, "x", null] }, "keyed", 0)).toBeNull();
  });

  it("混有非法条目时保留合法的", () => {
    const snap = parseCatalog({ data: [{ id: "a" }, { noId: 1 }, { id: 42 }] }, "keyed", 0);
    expect(snap?.ids).toEqual(new Set(["a"]));
  });

  it.each([
    ["缺 data", {}],
    ["data 不是数组", { data: { a: 1 } }],
    ["null", null],
    ["数组", [{ id: "a" }]],
    ["字符串", "x"],
    ["undefined", undefined],
  ])("不可采纳的响应形状(%s)返回 null", (_label, payload) => {
    expect(parseCatalog(payload, "keyed", 0)).toBeNull();
  });

  it("条目数离谱时整份拒掉,而**不是截断**", () => {
    /*
     * 突然变成几千条意味着我们在跟别的东西说话(劫持、错配的 baseUrl、
     * 某个返回聚合列表的代理)。
     *
     * 刻意不截断:截断会静默丢掉免费模型,而丢掉哪些取决于上游的排序,
     * 症状是"某个模型时有时无"。
     */
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` }));
    expect(parseCatalog({ data: many }, "keyed", 0)).toBeNull();
    // 上限内的正常通过 —— 证明拒绝来自条数而不是别的原因。
    const ok = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` }));
    expect(parseCatalog({ data: ok }, "keyed", 0)?.entries).toHaveLength(100);
  });

  it("isModelEntry 只认 id 是字符串的对象", () => {
    expect(isModelEntry({ id: "a" })).toBe(true);
    expect(isModelEntry({ id: 1 })).toBe(false);
    expect(isModelEntry([{ id: "a" }])).toBe(false);
    expect(isModelEntry(null)).toBe(false);
  });
});

describe("身份与槽位", () => {
  it("有 key 是 keyed,无 key 是 keyless", () => {
    expect(slotOf({ apiKey: "k", proxyId: null })).toBe("keyed");
    expect(slotOf({ apiKey: "", proxyId: null })).toBe("keyless");
  });

  it("catalogIdentityOf 取第一个可用 Worker", () => {
    const id = catalogIdentityOf(workerConfig(["w1", "w2"]));
    expect(id.apiKey).toBe("fake-key-w1-not-real");
    expect(slotOf(id)).toBe("keyed");
  });

  it("没有 Worker 时是免 key 身份 —— 首次配置前也能看目录", () => {
    // 实测 Zen 的目录端点免鉴权可读,这对「方便简单」有实际帮助。
    const id = catalogIdentityOf(config());
    expect(id.apiKey).toBe("");
    expect(slotOf(id)).toBe("keyless");
  });

  /*
   * ## 下面三条替换了一条恒真的空壳（第六轮审核查出）
   *
   * 原先这里写的是 `expect(catalogIdentityOf(cfg)).toEqual(catalogIdentityOf(cfg))`,
   * 名义上验"只有一处定义",实际**恒真** —— 同一个函数调两次当然相等。
   *
   * 而上面那条「取第一个**可用** Worker」只有一个 Worker,所以"可用"这个
   * 限定词无从失败。变异验证:把 `usableTargets(config)[0]` 换成
   * `config.workers[0]`（即去掉 `isUsable` 过滤）后**1274 条测试全绿**。
   *
   * 归类是第五轮的第三类「调用点存在但输入集为空」:全部 fixture 的
   * `workers[0]` 恒为 `enabled: true` 且有 key。而"先配一个免 key 的试试,
   * 再加带 key 的"恰好是很自然的配置顺序。
   */
  it("跳过**已停用**的 Worker —— 不能拿停用者的 key 与出口拉目录", () => {
    /*
     * 后果之一是出口错:目录查询会经一个**用户已明确停用**的代理发出。
     * proxyId 一并断言,因为那是"经哪个出口"的唯一依据。
     */
    const cfg = config({
      workers: [
        {
          id: "w1",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-DISABLED-not-real",
          enabled: false,
          proxyId: null,
        },
        {
          id: "w2",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-w2-not-real",
          enabled: true,
          proxyId: null,
        },
      ],
    });
    const id = catalogIdentityOf(cfg);
    expect(id.apiKey).toBe("fake-key-w2-not-real");
  });

  it("跳过**没有 key** 的 Worker —— 否则槽位算成 keyless,交集静默失效", () => {
    /*
     * 这条是三条里最要紧的:它钉住的不是"取哪个 key",而是**槽位**。
     *
     * 若免 key 的 w1 排在前面而这里不过滤,`slotOf` 会返回 `keyless` →
     * 目录被填进 keyless 槽,而 `relay.ts` 读的是 `cached("keyed")` →
     * 拿到 null → **交集静默失效**,退回 Phase 5 那个偏宽的放行。
     * 也就是说 Phase 6 的核心交付会在一种很自然的配置下无声消失。
     *
     * 用 `kind: "anonymous"` 构造免 key 的合法 Worker —— `WorkerSchema` 的
     * `refine` 是**单向**的（只要求 authenticated 必须有 key），所以这个形态合法。
     */
    const cfg = config({
      workers: [
        { id: "w1", name: "", kind: "anonymous", apiKey: "", enabled: true, proxyId: null },
        {
          id: "w2",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-w2-not-real",
          enabled: true,
          proxyId: null,
        },
      ],
    });
    const id = catalogIdentityOf(cfg);
    expect(id.apiKey).toBe("fake-key-w2-not-real");
    expect(slotOf(id)).toBe("keyed");
  });

  it("首位不可用时**出口也不能取它的** —— proxyId 一起跳过", () => {
    /*
     * 单独一条,因为 `apiKey` 与 `proxyId` 是从**同一个** target 上取的两个字段,
     * 而只断言 key 的话,一个"取 key 从过滤后的、取 proxyId 从原数组"的
     * 错误实现照样能过。
     */
    const cfg = config({
      proxies: [
        {
          id: "p1",
          name: "停用者的代理",
          type: "socks5",
          host: "203.0.113.9",
          port: 1080,
          source: "manual",
          direct: true,
        },
      ],
      workers: [
        {
          id: "w1",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-DISABLED-not-real",
          enabled: false,
          proxyId: "p1",
        },
        {
          id: "w2",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-w2-not-real",
          enabled: true,
          proxyId: null,
        },
      ],
    });
    const id = catalogIdentityOf(cfg);
    expect(id.proxyId).toBeNull();
  });

  it("**目录请求经该 Worker 绑定的出口发出** —— 不是本机直连", async () => {
    /*
     * 第六轮审核查出这条完全没有守卫:把 `catalogIdentityOf` 或 `#doFetch` 里的
     * `proxyId` 改成硬编码 `null` 之后 **1279 条测试全绿**。归类是第三类
     * 「输入集为空」—— 全部 fixture 的 Worker 都是 `proxyId: null`。
     *
     * ## 为什么这条比它看起来重要
     *
     * 目录请求**带着某个 Worker 的 key**。若它从本机默认出口发出,这个账号就在
     * 一个与转发**不同的公网 IP** 上被上游看到 —— 而「每个 Worker 经各自独立的
     * 公网出口」是这个项目**存在的理由**。上游按 IP+key 做关联时,所有账号的
     * 目录查询都从同一个 IP 出去,等于把隔离在这条路径上整体放弃。
     *
     * 而它**完全静默**:目录照常拉回来了,本地无论怎么看都正常。
     *
     * 断言点选在 `DispatcherPool.get` 收到的 target 上 —— 那是 `proxyId`
     * 唯一能产生可观察后果的地方(见 `fakeDeps` 的 `targets()`)。
     */
    const cfg = config({
      proxies: [
        {
          id: "px1",
          name: "w1 的专属出口",
          type: "socks5",
          host: "203.0.113.9",
          port: 1080,
          source: "manual",
          direct: true,
        },
      ],
      workers: [
        {
          id: "w1",
          name: "",
          kind: "authenticated",
          apiKey: "fake-key-w1-not-real",
          enabled: true,
          proxyId: "px1",
        },
      ],
    });

    const id = catalogIdentityOf(cfg);
    // 身份必须带出 Worker 的出口 —— 这一半钉住 `catalogIdentityOf`。
    expect(id.proxyId).toBe("px1");

    const f = fakeDeps([catalogResponse(["a"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    await cat.ensure(id, cfg, f.upstreamOf);

    // 而这一半钉住 `#doFetch` 真的把它用上了,而不是只放在类型里。
    expect(f.targets()).toEqual(["direct:px1"]);
  });
});

describe("ModelCatalog", () => {
  it("首次 ensure 拉一次,之后新鲜期内不再拉", async () => {
    const f = fakeDeps([catalogResponse(["a", "b"])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a", "b"]));
    expect(f.calls()).toBe(1);

    now += TTL - 1;
    await cat.ensure(id, cfg, f.upstreamOf);
    // 脚本只有一项,再拉一次会抛"脚本用尽" —— 所以这条同时验了"没再拉"。
    expect(f.calls()).toBe(1);
  });

  it("过期后 ensure 会重新拉", async () => {
    const f = fakeDeps([catalogResponse(["a"]), catalogResponse(["a", "c"])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL + 1;
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a", "c"]));
    expect(f.calls()).toBe(2);
  });

  it("**拉取失败时继续用旧的** —— 上游抖动时目录不跟着消失", async () => {
    /*
     * 这是「校验过的最后成功缓存」的核心性质。先前 `/v1/models` 每次请求都
     * 打一次上游,于是上游抖动时目录跟着消失 —— 而目录为空等于
     * OpenCode 的模型列表整个空掉。
     */
    const f = fakeDeps([catalogResponse(["a", "b"]), new Error("网络断了")]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL + 1;
    const after = await cat.ensure(id, cfg, f.upstreamOf);
    expect(after?.ids).toEqual(new Set(["a", "b"]));
    expect(f.calls()).toBe(2);
  });

  it("旧缓存**永不硬过期** —— 一份三天前的目录好过网关不可用", async () => {
    const f = fakeDeps([catalogResponse(["a"]), new Error("还是断的")]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += 3 * 24 * 60 * 60 * 1000; // 三天
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a"]));
    // cached() 也仍然给得出来。
    expect(cat.cached("keyed")?.ids).toEqual(new Set(["a"]));
  });

  it("**空 data 的 200 不替换旧缓存**", async () => {
    /*
     * 最要紧的一条。采纳一份空目录会让免费集清空 → 网关拒绝一切,
     * 而这比拉取失败更糟(失败时旧目录还在)。
     */
    const f = fakeDeps([catalogResponse(["a", "b"]), catalogResponse([])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL + 1;
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a", "b"]));
  });

  it("非 2xx 不替换旧缓存,且**释放响应体**", async () => {
    // 不读体也要释放 —— 悬挂的连接会占着池直到 bodyTimeout。
    const errorResponse = catalogResponse(["x"], 503);
    const f = fakeDeps([catalogResponse(["a"]), errorResponse]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL + 1;
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a"]));
    expect(errorResponse.bodyUsed || errorResponse.body === null).toBe(true);
  });

  it("响应不是合法 JSON 时不替换旧缓存", async () => {
    const bad = new UndiciResponse("<html>不是 JSON</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const f = fakeDeps([catalogResponse(["a"]), bad]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL + 1;
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["a"]));
  });

  it("从来没成功过时返回 null —— 与「有旧的」区分开", async () => {
    const f = fakeDeps([new Error("一直失败")]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);
    expect(await cat.ensure(catalogIdentityOf(cfg), cfg, f.upstreamOf)).toBeNull();
    expect(cat.cached("keyed")).toBeNull();
  });

  it("cached() **绝不发请求**", async () => {
    // 转发路径只读缓存,所以这一条是"转发不依赖网络"的落点。
    const f = fakeDeps([]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    expect(cat.cached("keyed")).toBeNull();
    expect(f.calls()).toBe(0);
  });

  it("并发 ensure 合流成一次上游请求", async () => {
    /*
     * 没有合流的话,启动瞬间的一批请求会各打一次目录 ——
     * 而它们要的是同一份东西。
     */
    const f = fakeDeps([catalogResponse(["a"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    const all = await Promise.all([
      cat.ensure(id, cfg, f.upstreamOf),
      cat.ensure(id, cfg, f.upstreamOf),
      cat.ensure(id, cfg, f.upstreamOf),
    ]);
    expect(f.calls()).toBe(1);
    for (const snap of all) expect(snap?.ids).toEqual(new Set(["a"]));
  });

  it("两个身份槽位互不影响", async () => {
    /*
     * 实测带 key 与免 key 看到**不同的目录**(带 key 独有 test／
     * test-novita-dsf4.1,免 key 独有 claude-sonnet-4／deepseek-v4-flash-free)。
     * 而两个不同账号看到的差异项**完全相同** —— 所以是两个槽位,不是 per-Worker。
     */
    const f = fakeDeps([catalogResponse(["a", "test"]), catalogResponse(["a", "claude-sonnet-4"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const withKey = workerConfig(["w1"]);
    const noKey = config();

    await cat.ensure(catalogIdentityOf(withKey), withKey, f.upstreamOf);
    await cat.ensure(catalogIdentityOf(noKey), noKey, f.upstreamOf);

    expect(cat.cached("keyed")?.ids.has("test")).toBe(true);
    expect(cat.cached("keyed")?.ids.has("claude-sonnet-4")).toBe(false);
    expect(cat.cached("keyless")?.ids.has("claude-sonnet-4")).toBe(true);
    expect(f.calls()).toBe(2);
  });

  it("带 key 的槽位真的发了 Bearer,免 key 的没发", async () => {
    // 槽位不只是个标签 —— 它必须对应真实发出去的凭证。
    const f = fakeDeps([catalogResponse(["a"]), catalogResponse(["a"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const withKey = workerConfig(["w1"]);
    const noKey = config();

    await cat.ensure(catalogIdentityOf(withKey), withKey, f.upstreamOf);
    await cat.ensure(catalogIdentityOf(noKey), noKey, f.upstreamOf);

    expect(f.keys()[0]).toBe("Bearer fake-key-w1-not-real");
    expect(f.keys()[1]).toBe("Bearer ");
  });

  it("isFresh:TTL 边界", () => {
    const cat = new ModelCatalog({ clock: () => 0 });
    const snap = parseCatalog({ data: [{ id: "a" }] }, "keyed", 1000);
    if (snap === null) throw new Error("构造失败");
    const cfg = config();
    expect(cat.isFresh(snap, cfg, 1000 + TTL - 1)).toBe(true);
    expect(cat.isFresh(snap, cfg, 1000 + TTL)).toBe(false);
  });

  it("isFresh:时钟回拨当作新鲜,不当成过期", () => {
    /*
     * NTP 校正或休眠唤醒会让 `now < fetchedAt`。把负数年龄当成"超级过期"
     * 会在时钟一跳时触发一轮无意义的刷新。
     */
    const cat = new ModelCatalog({ clock: () => 0 });
    const snap = parseCatalog({ data: [{ id: "a" }] }, "keyed", 10_000);
    if (snap === null) throw new Error("构造失败");
    expect(cat.isFresh(snap, config(), 5000)).toBe(true);
  });

  it("catalogTtlMs 可配且真的生效", async () => {
    const f = fakeDeps([catalogResponse(["a"]), catalogResponse(["b"])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = config({
      models: { catalogTtlMs: 60_000 },
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "k-not-real", enabled: true, proxyId: null },
      ],
    });
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += 60_001;
    expect((await cat.ensure(id, cfg, f.upstreamOf))?.ids).toEqual(new Set(["b"]));
  });

  it("status() 不含凭证", async () => {
    const f = fakeDeps([catalogResponse(["a", "b"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);
    await cat.ensure(catalogIdentityOf(cfg), cfg, f.upstreamOf);

    const status = cat.status(2000);
    expect(status).toEqual([{ slot: "keyed", total: 2, ageMs: 1000 }]);
    // 整段序列化后不得出现 key 的任何片段。
    expect(JSON.stringify(status)).not.toContain("fake-key");
  });
});

describe("refreshIfStale —— 后台刷新与失败退避", () => {
  /**
   * 让后台任务**彻底**跑完。
   *
   * 必须过一个**宏任务**,不能只 await 几个 `Promise.resolve()`。
   * 我第一版写的是 5 个微任务 tick,而那不足以让 `#fetchOnce` 里
   * `.finally()` 中的 `#inFlight.delete` 执行 —— 于是下一次调用会**合流到
   * 那个已经完成的 promise 上**,根本不发新请求。
   *
   * 后果是这一组测试**全部可能因错误的原因通过**:我断言"第二次调用没有
   * 发请求,所以退避生效了",而实际原因是 in-flight 去重还没清理。
   * 那正是纪律 #1 的形态 —— 断言为真,但它证明的不是我说的那件事。
   *
   * 是这一组里唯一一条**真的需要**第三次请求发出去的测试把它暴露出来的
   * (期望 'b' 却拿到 'a')。
   */
  const settle = async (): Promise<void> => {
    await new Promise((r) => {
      setTimeout(r, 0);
    });
  };

  it("过期时刷一次,且**不阻塞调用方**", async () => {
    const f = fakeDeps([catalogResponse(["a"])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);

    // 同步返回 —— 没有 await。
    cat.refreshIfStale(catalogIdentityOf(cfg), cfg, f.upstreamOf);
    expect(cat.cached("keyed")).toBeNull(); // 还没回来

    await settle();
    expect(cat.cached("keyed")?.ids).toEqual(new Set(["a"]));
  });

  it("新鲜时不刷", async () => {
    const f = fakeDeps([catalogResponse(["a"])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    await cat.ensure(id, cfg, f.upstreamOf);
    now += TTL - 1;
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1);
  });

  it("**失败后退避** —— 否则这里是个放大器", async () => {
    /*
     * 这条对应我自己写坏又被集成测试查出来的一处缺陷。
     *
     * 第一版在**每个转发请求**上调 refreshIfStale,而拉取失败**不填缓存** ——
     * 于是下一个请求发现仍然过期,又发一次。稳态下一次客户端请求对应
     * **两次**上游请求,而这个放大恰好发生在上游已经不稳的时候。
     *
     * 集成测试当时报的是"expected length 1 but got 2",13 条一起红。
     */
    const f = fakeDeps([new Error("失败1"), new Error("失败2")]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1);

    // 紧接着再来一次 —— 被退避压住。
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1);

    // 退避到期后才再试。
    now += 30_000;
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(2);
  });

  it("高频调用下退避真的收敛 —— **每次之间都排空**,不靠 in-flight 去重", async () => {
    /*
     * ## 这条测试第一版是空壳,变异验证查出来的
     *
     * 我原先写的是"连调 10000 次 refreshIfStale,断言只发 1 次请求"。
     * 那条断言**在退避被移除后依然全绿** —— 因为一万次调用全在同一个同步
     * 块里,`#inFlight` 从头到尾没被清理过,于是**合流机制**独自把它们
     * 收敛成一次。我以为自己在验退避,实际在验去重。
     *
     * 这是纪律 #1 的第二类形态:**条件被另一层顺带满足**。修法是在每次调用
     * 之间排空事件循环,让 in-flight 真的清掉 —— 此时唯一还能阻止重复请求的
     * 就只有退避。
     *
     * 迭代数从 10000 降到 30:每次排空要过一个宏任务,而 30 次已经足够
     * 区分"收敛"与"每次都发"(后者会在第 2 次就因脚本用尽而炸)。
     * 规模不是这条测试的重点,**每次之间排空**才是。
     */
    const f = fakeDeps([new Error("失败")]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    for (let i = 0; i < 30; i += 1) {
      cat.refreshIfStale(id, cfg, f.upstreamOf);
      await settle();
    }
    expect(f.calls()).toBe(1);
  });

  it("成功后清掉退避 —— 否则下一次过期还会被压住", async () => {
    const f = fakeDeps([new Error("失败"), catalogResponse(["a"]), catalogResponse(["b"])]);
    let now = 1000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    now += 30_000;
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(cat.cached("keyed")?.ids).toEqual(new Set(["a"]));

    // 成功之后再过 TTL,应当立刻可以再刷(不被那次远古失败压住)。
    now += TTL + 1;
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(cat.cached("keyed")?.ids).toEqual(new Set(["b"]));
  });

  it("**校验没过也算失败**,同样进退避", async () => {
    /*
     * 四条 return null 路径(网络异常、非 2xx、体不是 JSON、校验没过)
     * 是同一个结论的四种原因。失败记账放在**汇合点**而不是四条路径上 ——
     * 那种分叉迟早会漏掉新加的第五条(纪律 #4)。
     *
     * 这里用"空 data"驱动最容易被漏的那条:它是个 200,看起来最像成功。
     */
    const f = fakeDeps([catalogResponse([]), catalogResponse([])]);
    const cat = new ModelCatalog({ clock: () => 1000 });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1);

    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1); // 被退避压住 —— 200 也算失败
  });

  it("**时钟回拨后退避不生效** —— 一次 NTP 校正不该把目录冻住", async () => {
    /*
     * 第六轮审核查出这条守卫没有断言:退避那组测试只**推进**时钟,从来没回拨过。
     * 实测把 `age >= 0 &&` 删掉后全绿。
     *
     * 后果很具体:NTP 校正或休眠唤醒让 `now < failedAt` → `age` 为负 →
     * `age < FAILURE_BACKOFF_MS` 恒为真 → **刷新被永久冻住**,直到时钟追回来
     * (可以是几小时)。而 `refreshIfStale` 是 `/v1/models` 与启动预热的路径,
     * 所以症状是"目录停更":新上架的模型一直不生效。完全静默。
     *
     * 注意这与 `isFresh` 里那条**方向相反**:那里 `catalogTtlMs` 的下界恒为正,
     * 所以负 age 自然落在"新鲜"一侧,守卫是数学死代码(已删)。同样的写法
     * 一处是死的、一处是承重的 —— 两边的注释都写明了这个区别。
     */
    const f = fakeDeps([new Error("失败"), catalogResponse(["a"])]);
    let now = 10_000_000;
    const cat = new ModelCatalog({ clock: () => now });
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);

    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls()).toBe(1);

    // 回拨一小时 —— 绝对值远大于退避窗口,但方向是负的。
    now -= 60 * 60 * 1000;
    cat.refreshIfStale(id, cfg, f.upstreamOf);
    await settle();
    expect(f.calls(), "回拨后必须仍然允许重试").toBe(2);
    expect(cat.cached("keyed")?.ids).toEqual(new Set(["a"]));
  });

  it("后台失败不产生 unhandledRejection", async () => {
    /*
     * 这是个无人 await 的 void 调用。若内部不吞异常,一次目录拉取失败
     * 会变成 unhandledRejection —— Node 默认会让进程退出。
     */
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const f = fakeDeps([new Error("后台炸了")]);
      const cat = new ModelCatalog({ clock: () => 1000 });
      const cfg = workerConfig(["w1"]);
      cat.refreshIfStale(catalogIdentityOf(cfg), cfg, f.upstreamOf);
      await settle();
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

/* ================================================================== *
 * 体积上限（缺口 #7）
 * ================================================================== */

describe("目录响应的体积上限", () => {
  it("**单条目但体积巨大**的响应不被采纳 —— 条目数闸门挡不住它", async () => {
    /*
     * `MAX_CATALOG_ENTRIES` 的闸门在 `parseCatalog` 里，也就是把整个体读进内存
     * **之后**。实测过：一个单条目、40 MiB 的响应能通过条目数那一层。
     * 条目数与体积是两回事 —— 一个条目的字段可以任意大。
     *
     * 这里用 9 MiB（上限 8 MiB）的单条目响应，比 40 MiB 快得多而性质相同。
     */
    const huge = "x".repeat(9 * 1024 * 1024);
    const body = JSON.stringify({ object: "list", data: [{ id: "m1", description: huge }] });
    const oversized = new UndiciResponse(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);
    const cat = new ModelCatalog();
    const f = fakeDeps([oversized]);

    // 不采纳 —— 与"校验没过"同一个结局（返回 null，保留旧缓存）。
    expect(await cat.ensure(id, cfg, f.upstreamOf)).toBeNull();
    expect(cat.cached("keyed")).toBeNull();
  });

  it("正常大小的响应照常采纳 —— 上限不是把一切都挡掉", async () => {
    /*
     * 这条与上一条配对：少了它，一个"永远返回 null"的实现也能让上一条通过。
     */
    const cfg = workerConfig(["w1"]);
    const id = catalogIdentityOf(cfg);
    const cat = new ModelCatalog();
    const f = fakeDeps([catalogResponse(["a", "b"])]);

    const snapshot = await cat.ensure(id, cfg, f.upstreamOf);
    expect(snapshot?.ids).toEqual(new Set(["a", "b"]));
  });
});
