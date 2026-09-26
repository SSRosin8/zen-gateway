import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Response as UndiciResponse } from "undici";
import { fetchUpstream, type UpstreamDeps } from "../../src/core/upstream/fetch.ts";
import { DispatcherPool } from "../../src/core/proxy/dispatcher.ts";
import { SelectorLockRegistry } from "../../src/core/proxy/selectorLock.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import type { ClashController } from "../../src/core/proxy/clash/controller.ts";

/**
 * 转发侧的出口:桥接 selector 与建连的原子性、转发与探测共用出口机构,
 * 以及本机出口配置错误的归因。
 *
 * 出口隔离是这个项目存在的理由,而 probe 侧有 `selectorLock.test.ts` 守着;
 * 这里守的是**转发**侧。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带一个 Clash 内核与一个只能桥接的代理的配置。 */
function bridgeConfig(): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "bridge-test-token-not-real" },
    clash: {
      enabled: true,
      selectionMode: "manual",
      activeBridgeId: "k1",
      bridges: [
        {
          id: "k1",
          name: "内核一",
          apiBase: "http://127.0.0.1:9090",
          localProxyPort: 17891,
          selectorGroup: "GLOBAL",
        },
      ],
    },
    proxies: [
      {
        id: "p-bridge",
        // 刻意保留真实订阅里常见的形态：emoji flag 序列 + CJK + 连续空格。
        // 这些必须能原样走到 select()，所以 clashNodeName 不能被 IdSchema 收窄。
        name: "🇯🇵 东京  节点",
        clashNodeName: "🇯🇵 东京  节点",
        type: "vless",
        host: "example.invalid",
        port: 443,
        source: "manual",
        direct: false,
        bridgeable: true,
        bridgeId: "k1",
      },
    ],
    workers: [
      { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key", enabled: true, proxyId: "p-bridge" },
    ],
  });
}

describe("桥接转发：select 与建连必须原子，且锁在响应头后释放", () => {
  let pool: DispatcherPool;

  beforeEach(() => {
    pool = new DispatcherPool({ headersTimeoutMs: 2_000, bodyTimeoutMs: 2_000 });
  });

  afterEach(async () => {
    await pool.close();
  });

  function deps(
    config: Config,
    events: string[],
    fetchImpl: () => Promise<UndiciResponse>,
    locks = new SelectorLockRegistry(),
  ): UpstreamDeps {
    const controller = {
      async select(group: string, node: string) {
        events.push(`select:${group}/${node}`);
      },
    } as unknown as ClashController;

    return {
      config,
      dispatchers: pool,
      locks,
      controllerFor: () => controller,
      fetchImpl: (async () => {
        events.push("fetch");
        return fetchImpl();
      }) as unknown as NonNullable<UpstreamDeps["fetchImpl"]>,
    };
  }

  it("**`select()` 失败包成 `EgressSetupError`** —— 本机 Clash 配置错不该冷却 Worker", async () => {
    /*
     * ## 触发条件
     *
     * 触发条件很窄：本机 Clash 开了鉴权而 `data/config.json` 里 `apiSecret`
     * 为空，例如 Clash 内核换成了要求鉴权的版本。
     *
     * 切 selector 是**本机控制面**操作，它失败意味着本机配置不对（Clash 开了
     * 鉴权、secret 变了、分组改名）。`fetch.ts` 里另外四处配置错误都包成了
     * `EgressSetupError`，唯独 `lock.run()` 里这一句没有。
     *
     * ## 不包的后果：破坏不变量 #4
     *
     * 实测链条：`ControllerError` 逃出去 → `classifyError` 归 `transport`
     * → `isRetryable` 为真且 `blameWorker` 为真 → 重试链把每个 Worker 依次
     * 试一遍并**各记一次失败进冷却**。
     *
     * 于是一个本机 Clash 的 secret 配错，会把三个健康的付费账号全部打进退避，
     * 而客户端看到的是 502「上游不可达」—— 用户会去查上游和网络，
     * 真实原因（本机配置）被完全掩盖。修复后是 503 `egress_unavailable`，
     * 消息直接说「检查 apiSecret 配置」。
     *
     * 生产对照（同一条命令，修复前后）：
     * ```
     * 修复前: HTTP 502 | upstream_unreachable | 上游请求失败:Controller 拒绝鉴权(401)
     * 修复后: HTTP 503 | egress_unavailable   | 上游请求失败:Controller 拒绝鉴权(401);检查 apiSecret 配置
     * ```
     */
    const { EgressSetupError } = await import("../../src/core/upstream/fetch.ts");
    const { ControllerError } = await import("../../src/core/proxy/clash/controller.ts");
    const events: string[] = [];
    const config = bridgeConfig();

    const failing = {
      ...deps(config, events, async () => new UndiciResponse("{}", { status: 200 })),
      controllerFor: () =>
        ({
          async select() {
            throw new ControllerError("Controller 拒绝鉴权(401);检查 apiSecret 配置", "auth", 401);
          },
        }) as unknown as ClashController,
    };

    await expect(
      fetchUpstream(
        { url: "http://upstream.invalid/v1/x", method: "POST", headers: {}, body: null, proxyId: "p-bridge" },
        failing,
      ),
    ).rejects.toThrow(EgressSetupError);

    // 而且**根本没发出上游请求** —— 切不动节点就不该带着 key 从错误的出口出去。
    expect(events).not.toContain("fetch");
  });

  it("`fetch()` 本身的失败**不**包成 `EgressSetupError` —— 那是真实网络失败", async () => {
    /*
     * 上一条的反向钉子，而且是承重的：若图省事把整个 `lock.run()` 回调包进
     * try，真实的网络失败就会被当成配置错误 —— 于是**不重试、不归咎 Worker**，
     * 一个真的挂掉的上游永远不会让任何 Worker 进冷却，重试链形同虚设。
     *
     * 两个方向的代价不对称但都实在：漏包（上一条）会冷却健康 Worker，
     * 过度包（这一条）会让冷却整体失效。所以只包 `select()` 那一句。
     */
    const { EgressSetupError } = await import("../../src/core/upstream/fetch.ts");
    const events: string[] = [];
    const config = bridgeConfig();

    await expect(
      fetchUpstream(
        { url: "http://upstream.invalid/v1/x", method: "POST", headers: {}, body: null, proxyId: "p-bridge" },
        deps(config, events, async () => {
          throw new Error("ECONNRESET");
        }),
      ),
    ).rejects.not.toBeInstanceOf(EgressSetupError);

    // select 成功了才轮到 fetch 失败 —— 确认走的确实是这条路径。
    expect(events).toContain("fetch");
  });

  it("转发前会切换 selector，且顺序是 select → fetch", async () => {
    /*
     * 先前这条完全没有断言:把 `lock.run()` 连同 `controller.select()`
     * 整个删掉、直接 `return doFetch(...)`,全套测试依然全绿。
     * 而删掉它意味着流量从 selector 当前选中的**任意**节点出去 ——
     * 出口隔离彻底失效,症状却是"看起来在工作"。
     */
    const events: string[] = [];
    const config = bridgeConfig();

    await fetchUpstream(
      { url: "http://upstream.invalid/v1/x", method: "POST", headers: {}, body: null, proxyId: "p-bridge" },
      deps(config, events, async () => new UndiciResponse("{}", { status: 200 })),
    );

    // 节点名含 emoji 与 CJK，必须原样传给 select()。
    expect(events).toEqual(["select:GLOBAL/🇯🇵 东京  节点", "fetch"]);
  });

  it("并发转发被锁串行化 —— selector 的 now 是进程外全局状态", async () => {
    /*
     * 两个并发请求若各自切换 selector,会互相换掉对方的出口节点:
     * Worker A 的流量从 Worker B 的 IP 出去。这正是本项目要避免的事
     * (多账号同 IP 被上游关联)。
     */
    const events: string[] = [];
    const config = bridgeConfig();
    const locks = new SelectorLockRegistry();

    const call = (tag: string) =>
      fetchUpstream(
        { url: `http://upstream.invalid/${tag}`, method: "POST", headers: {}, body: null, proxyId: "p-bridge" },
        {
          ...deps(config, events, async () => {
            await sleep(20);
            events.push(`done:${tag}`);
            return new UndiciResponse("{}", { status: 200 });
          }, locks),
          controllerFor: () =>
            ({
              // 参数带 `_` —— 接口要求这两个形参，这个假实现不用它们。
              async select(_group: string, _node: string) {
                events.push(`select:${tag}`);
                await sleep(10);
              },
            }) as unknown as ClashController,
        },
      );

    await Promise.all([call("a"), call("b")]);

    // 第一条的 select 与 fetch 必须都在第二条的 select 之前 —— 否则两者交叉。
    const firstSelect = events.findIndex((e) => e.startsWith("select:"));
    const firstTag = events[firstSelect]!.slice("select:".length);
    const secondSelectIdx = events.findIndex(
      (e, i) => i > firstSelect && e.startsWith("select:"),
    );
    const firstFetchDone = events.indexOf(`done:${firstTag}`);

    expect(firstFetchDone).toBeGreaterThan(-1);
    expect(secondSelectIdx).toBeGreaterThan(-1);
    expect(
      firstFetchDone,
      `第一条的 fetch 必须在第二条 select 之前完成，实际顺序: ${JSON.stringify(events)}`,
    ).toBeLessThan(secondSelectIdx);
  });

  it("锁在响应头到达即释放，不等响应体读完", async () => {
    /*
     * 不变量 #5 的后半段。锁若跨到流结束,一条几分钟的 SSE 会把整个网关
     * 串行化。文件头警告的 Promise 同化陷阱正是这里:任务里只能做
     * "切换 + 建连"并返回**响应对象**,返回读体的 Promise 会延长锁。
     *
     * 先前把实现改成在锁内 `await res.text()` 之后,测试依然全绿。
     */
    const events: string[] = [];
    const config = bridgeConfig();
    const locks = new SelectorLockRegistry();

    let bodyRead = false;
    // 响应体是惰性的:只有真去读才会置位。
    const lazyBody = new UndiciResponse(
      new ReadableStream({
        async pull(controller) {
          await sleep(30);
          bodyRead = true;
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      }),
      { status: 200 },
    );

    const res = await fetchUpstream(
      { url: "http://upstream.invalid/v1/x", method: "POST", headers: {}, body: null, proxyId: "p-bridge" },
      deps(config, events, async () => lazyBody, locks),
    );

    // 响应头已到,响应体尚未读 —— 此时锁必须已经释放:再发一次能立刻拿到锁。
    expect(bodyRead).toBe(false);
    let secondRan = false;
    await locks.forBridge("k1").run(async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
    expect(bodyRead).toBe(false);

    await res.text();
    expect(bodyRead).toBe(true);
  });

  it("直连出口不经 selector 锁（各自独立 dispatcher）", async () => {
    // 对照组:只有桥接才需要这把锁,直连走这条路会白白串行化。
    const events: string[] = [];
    const config = bridgeConfig();
    const locks = new SelectorLockRegistry();
    const asked: string[] = [];
    const forBridge = locks.forBridge.bind(locks);
    locks.forBridge = (id: string) => {
      asked.push(id);
      return forBridge(id);
    };

    await fetchUpstream(
      { url: "http://upstream.invalid/v1/x", method: "POST", headers: {}, body: null, proxyId: null },
      deps(config, events, async () => new UndiciResponse("{}", { status: 200 }), locks),
    );

    expect(events).toEqual(["fetch"]);
    expect(asked).toEqual([]);
  });
});

describe("转发与探测必须共用同一套出口机构", () => {
  let egress: EgressService;

  beforeEach(() => {
    egress = new EgressService({ timeouts: { headersTimeoutMs: 1_000, bodyTimeoutMs: 1_000 } });
  });

  afterEach(async () => {
    await egress.close();
  });

  it("多次取 upstreamDeps 返回同一个 dispatcher 池与同一套锁", () => {
    /*
     * 先前把 `upstreamDeps()` 改成每次返回 `new DispatcherPool()` +
     * `new SelectorLockRegistry()`,全套测试全绿 —— 而那正是 docstring
     * 描述的"锁分裂 + 连接池分裂"。
     *
     * 锁分裂的后果最隐蔽:Clash selector 的 `now` 是**进程外**全局状态,
     * 两套锁各自串行化但互不阻塞,于是探测在切到节点 A 的同时转发可能正切到 B
     * —— 探测量到的出口 IP 不是转发实际用的那个,而 `egressIp` 正是
     * 出口隔离报告的分组键。整份隔离结论会建立在错误数据上。
     */
    const config = bridgeConfig();
    const a = egress.upstreamDeps(config);
    const b = egress.upstreamDeps(config);

    expect(a.dispatchers, "dispatcher 池必须是同一个实例").toBe(b.dispatchers);
    expect(a.locks, "锁 registry 必须是同一个实例").toBe(b.locks);
  });

  it("同一内核的锁在两次取用之间是同一把", () => {
    const config = bridgeConfig();
    const a = egress.upstreamDeps(config);
    const b = egress.upstreamDeps(config);
    expect(a.locks.forBridge("k1")).toBe(b.locks.forBridge("k1"));
  });
});

describe("错误归因：本机配置问题不得报成客户端 400 或上游 502", () => {
  let egress: EgressService;

  beforeEach(() => {
    egress = new EgressService({ timeouts: { headersTimeoutMs: 1_000, bodyTimeoutMs: 1_000 } });
  });

  afterEach(async () => {
    await egress.close();
  });

  /** 代理已停用，但 Worker 仍启用并绑定它 —— schema 允许这种组合。 */
  function disabledProxyConfig(): Config {
    return ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: "attrib-token-not-real-xx" },
      proxies: [
        {
          id: "p-off",
          name: "停用的代理",
          type: "socks5",
          host: "127.0.0.1",
          port: 1080,
          source: "manual",
          direct: true,
          enabled: false,
        },
      ],
      workers: [
        { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key", enabled: true, proxyId: "p-off" },
      ],
    });
  }

  it("出口配置错误报 503 egress_unavailable，不是 400 invalid_request", async () => {
    /*
     * 「代理已停用」「Clash 没开」都是**本机配置**问题,客户端请求完全合法。
     * 报 400「请求无效」会让用户去检查请求体,而真实原因在配置里;
     * 更糟的是 OpenCode 这类客户端把 4xx 当成自己的错,不会重试。
     *
     * `errorMap.ts` 早就定义了 `egress_unavailable`(503),但先前**从未被接上**
     * —— grep 全仓只命中定义处。这是那条映射漏接的回归守卫。
     */
    const { createApp } = await import("../../src/server/app.ts");
    const cfg = disabledProxyConfig();
    const app = createApp({ configOf: () => cfg, egress, log: () => {} });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.gateway.relayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "big-pickle", messages: [] }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("egress_unavailable");
    expect(body.error.message).toContain("停用");
  });

  it("真实传输失败不被末位的配置错误覆盖分类", async () => {
    /*
     * `lastFailure` 先前被每次尝试无条件覆盖。于是一条
     * 「w1 传输失败 → w2 代理已停用」的链最终分类会变成 `bad_request`,
     * **一次真实的上游不可达被报成客户端 400**。
     *
     * 现在单独记 `lastRealFailure` 并优先报它。
     */
    const { runRetryChain } = await import("../../src/core/upstream/retry.ts");
    const { EgressSetupError } = await import("../../src/core/upstream/fetch.ts");
    const { DispatcherPool: Pool } = await import("../../src/core/proxy/dispatcher.ts");

    const script: Array<Error> = [
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      new EgressSetupError("代理 p-off 已停用"),
    ];
    let i = 0;

    const result = await runRetryChain({
      targets: [
        { workerId: "w1", apiKey: "k1", proxyId: null },
        { workerId: "w2", apiKey: "k2", proxyId: "p-off" },
      ],
      maxAttempts: 2,
      url: "http://upstream.invalid/x",
      method: "POST",
      body: null,
      buildHeaders: () => ({}),
      deps: {
        config: disabledProxyConfig(),
        dispatchers: new Pool({ headersTimeoutMs: 500, bodyTimeoutMs: 500 }),
        locks: new SelectorLockRegistry(),
        controllerFor: () => null,
        fetchImpl: (async () => {
          const item = script[i];
          i += 1;
          throw item ?? new Error("脚本用尽");
        }) as unknown as NonNullable<UpstreamDeps["fetchImpl"]>,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 真实失败优先 —— 不是被末位的配置错误覆盖成 bad_request。
      expect(result.kind).toBe("transport");
      expect(result.egressSetup).toBe(false);
    }
  });

  it("全链都是配置错误时才标 egressSetup", async () => {
    const { runRetryChain } = await import("../../src/core/upstream/retry.ts");
    const { EgressSetupError } = await import("../../src/core/upstream/fetch.ts");
    const { DispatcherPool: Pool } = await import("../../src/core/proxy/dispatcher.ts");

    const result = await runRetryChain({
      targets: [{ workerId: "w1", apiKey: "k1", proxyId: "p-off" }],
      maxAttempts: 1,
      url: "http://upstream.invalid/x",
      method: "POST",
      body: null,
      buildHeaders: () => ({}),
      deps: {
        config: disabledProxyConfig(),
        dispatchers: new Pool({ headersTimeoutMs: 500, bodyTimeoutMs: 500 }),
        locks: new SelectorLockRegistry(),
        controllerFor: () => null,
        fetchImpl: (async () => {
          throw new EgressSetupError("代理 p-off 已停用");
        }) as unknown as NonNullable<UpstreamDeps["fetchImpl"]>,
      },
    });

    if (!result.ok) expect(result.egressSetup).toBe(true);
  });

  it("apiKey 含控制字符时报 400 并指出是 apiKey，不是 502 上游不可达", async () => {
    /*
     * 含 CRLF 的 key 会让 undici 在 fetch 时抛错 → `classifyError` 归为
     * `transport` → 客户端收到「502 上游不可达」,**尽管请求根本没发出去**。
     * 用户会去查网络和上游状态,而真实原因是配置里那个 key 带了换行。
     */
    const { buildUpstreamHeaders, HeaderValidationError } = await import(
      "../../src/core/upstream/headers.ts"
    );
    const bad = `sk-key${String.fromCharCode(0x0d, 0x0a)}X-Injected: 1`;

    expect(() =>
      buildUpstreamHeaders({ clientHeaders: {}, apiKey: bad, streaming: false }),
    ).toThrow(HeaderValidationError);

    try {
      buildUpstreamHeaders({ clientHeaders: {}, apiKey: bad, streaming: false });
    } catch (err) {
      // 消息要指向 apiKey，但绝不回显 key 本身。
      expect((err as Error).message).toContain("apiKey");
      expect((err as Error).message).not.toContain("sk-key");
    }
  });
});
