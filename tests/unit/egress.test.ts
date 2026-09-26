import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { ConfigSchema, ProxySchema, type Config } from "../../src/shared/schema.ts";
import { EgressService, applyProbeResult } from "../../src/core/proxy/egress.ts";
import { isIpAddress, type IpEchoService } from "../../src/core/proxy/probe.ts";
import { fetchUpstream } from "../../src/core/upstream/fetch.ts";
import { runRetryChain } from "../../src/core/upstream/retry.ts";

const TIMEOUTS = { headersTimeoutMs: 3_000, bodyTimeoutMs: 10_000 };

const servers: Server[] = [];
const services: EgressService[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
}

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((s) => s.close()));
  await Promise.allSettled(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

function egress(echoUrl: string): EgressService {
  const echo: IpEchoService = {
    url: echoUrl,
    extract: (text) => (isIpAddress(text.trim()) ? text.trim() : null),
  };
  const svc = new EgressService({
    timeouts: TIMEOUTS,
    services: [echo],
    probeTimeoutMs: 3_000,
    controllerTimeoutMs: 3_000,
  });
  services.push(svc);
  return svc;
}

function config(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "A".repeat(32) },
    ...overrides,
  });
}

describe("probeProxy —— 直连与本机出口", () => {
  it("mode=none 探测本机出口", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const result = await egress(echo).probeProxy(config(), null);

    expect(result.outcome.ok).toBe(true);
    expect(result.outcome.ok && result.outcome.egressIp).toBe("198.51.100.5");
  });

  it("引用不存在的代理时如实失败,不退回本机出口", async () => {
    /*
     * 静默直连意味着这个 Worker 与其他 Worker 共用同一个公网 IP,
     * 而出口隔离正是本项目存在的理由。
     */
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const result = await egress(echo).probeProxy(config(), "不存在");

    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.ok === false && result.outcome.reason).toContain("不存在");
  });

  it("停用的代理不被探测", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const cfg = config({
      proxies: [
        {
          id: "p1",
          name: "停用节点",
          type: "socks5",
          host: "192.0.2.10",
          port: 1080,
          source: "manual",
          direct: true,
          enabled: false,
        },
      ],
    });

    const result = await egress(echo).probeProxy(cfg, "p1");
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.ok === false && result.outcome.reason).toContain("停用");
  });
});

describe("probeProxy —— 桥接", () => {
  /** 一个最小的假 Controller,记录收到的 selector 切换。 */
  async function fakeController(log: string[]): Promise<string> {
    return serve((req, res) => {
      const url = req.url ?? "";
      if (url === "/version") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ version: "1.10.0", meta: true }),
        );
        return;
      }
      if (req.method === "PUT" && url.startsWith("/proxies/")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const group = decodeURIComponent(url.replace("/proxies/", ""));
          log.push(`${group}=${(JSON.parse(body) as { name: string }).name}`);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(404).end();
    });
  }

  function bridgeConfig(controllerUrl: string, mixedPort: number): Config {
    return config({
      clash: {
        enabled: true,
        selectionMode: "manual",
        activeBridgeId: "b1",
        bridges: [
          {
            id: "b1",
            name: "本地内核",
            apiBase: controllerUrl,
            // 混合端口必须来自配置:实测本机 mihomo 用的并不是文档里的默认
            // 7890,硬编码默认值会让桥接静默连到一个没人监听的端口。
            localProxyPort: mixedPort,
            selectorGroup: "GLOBAL",
          },
        ],
      },
      proxies: [
        ProxySchema.parse({
          id: "p-bridge",
          name: "我的叫法",
          clashNodeName: "🇺🇲 示例节点2 IPLC  VIP2 网址:example.invalid",
          type: "vless",
          host: "192.0.2.11",
          port: 443,
          source: "controller",
          direct: false,
          bridgeable: true,
          bridgeId: "b1",
        }),
      ],
    });
  }

  it("切换到 clashNodeName 指定的节点,而不是 name", async () => {
    const log: string[] = [];
    const controller = await fakeController(log);
    // 本地混合端口在这里用一个 HTTP 正向代理:直接返回 IP 即可满足探测。
    const echo = await serve((_req, res) => res.writeHead(200).end("203.0.113.77"));
    const port = Number(new URL(echo).port);

    const cfg = bridgeConfig(controller, port);
    // 让 dispatcher 直连 echo 服务(把 echo 当作「混合端口」),
    // 于是能验证 selector 切换与请求发出的顺序,不必真跑一个代理。
    const result = await egress(echo).probeProxy(cfg, "p-bridge");

    expect(result.outcome.ok, JSON.stringify(result.outcome)).toBe(true);
    // selector 只认 Clash 自己的节点名;从订阅导入时两者可能不同。
    expect(log).toEqual(["GLOBAL=🇺🇲 示例节点2 IPLC  VIP2 网址:example.invalid"]);
  });

  it("Clash 未启用时桥接代理无法探测", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("203.0.113.77"));
    const cfg = bridgeConfig(echo, 7890);
    // 关掉 clash 并同步停用该代理(schema 要求二者一致)。
    const disabled = ConfigSchema.parse({
      ...cfg,
      clash: { ...cfg.clash, enabled: false },
      proxies: [{ ...cfg.proxies[0]!, enabled: false }],
    });

    const result = await egress(echo).probeProxy(disabled, "p-bridge");
    expect(result.outcome.ok).toBe(false);
  });
});

describe("Controller 缓存", () => {
  it("同一内核复用同一个客户端", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const cfg = config({
      clash: {
        enabled: true,
        bridges: [{ id: "b1", name: "内核", apiBase: "http://127.0.0.1:9090", localProxyPort: 7890 }],
        activeBridgeId: "b1",
      },
    });

    expect(svc.controllerFor(cfg, "b1")).toBe(svc.controllerFor(cfg, "b1"));
  });

  it("apiBase 变了就重建,不继续连旧地址", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const base = (apiBase: string) =>
      config({
        clash: {
          enabled: true,
          bridges: [{ id: "b1", name: "内核", apiBase, localProxyPort: 7890 }],
          activeBridgeId: "b1",
        },
      });

    const first = svc.controllerFor(base("http://127.0.0.1:9090"), "b1");
    const second = svc.controllerFor(base("http://127.0.0.1:9091"), "b1");
    expect(second).not.toBe(first);
  });

  it("内核不存在时返回 null", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    expect(egress(echo).controllerFor(config(), "没有")).toBeNull();
  });

  /*
   * 下面三条盖的是一个真实缺陷:缓存键先前用 `apiSecret.length` 做指纹,
   * 于是把一个打错的密码改成**同长度**的正确密码后,键不变 → 旧 Controller
   * 被复用 → 它构造时已把旧 secret 抓进 `#secret` → 永久 401。
   * 而「改成同长度的另一个值」正是修密码最常见的形态。
   *
   * 第一条只断言\"实例被重建\",这不够 —— 实例换了但仍可能带旧凭证。
   * 第二条断言**真的发出去的那个 header** 变了,那才是用户能观察到的后果。
   */
  it("等长但不同的 secret 必须重建 —— 长度指纹会撞键", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const withSecret = (apiSecret: string) =>
      config({
        clash: {
          enabled: true,
          bridges: [
            {
              id: "b1",
              name: "内核",
              apiBase: "http://127.0.0.1:9090",
              apiSecret,
              localProxyPort: 7890,
            },
          ],
          activeBridgeId: "b1",
        },
      });

    // 两个 secret 长度刻意相同,只有内容不同。
    const wrong = "secret-aaa";
    const right = "secret-bbb";
    expect(wrong).toHaveLength(right.length);

    const first = svc.controllerFor(withSecret(wrong), "b1");
    const second = svc.controllerFor(withSecret(right), "b1");
    expect(second).not.toBe(first);
  });

  it("重建后的 Controller 真的带新 secret 发请求", async () => {
    const seen: Array<string | undefined> = [];
    const api = await serve((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" }).end('{"version":"v1"}');
    });
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const withSecret = (apiSecret: string) =>
      config({
        clash: {
          enabled: true,
          bridges: [
            { id: "b1", name: "内核", apiBase: api, apiSecret, localProxyPort: 7890 },
          ],
          activeBridgeId: "b1",
        },
      });

    await svc.controllerFor(withSecret("secret-aaa"), "b1")!.version();
    await svc.controllerFor(withSecret("secret-bbb"), "b1")!.version();

    expect(seen).toEqual(["Bearer secret-aaa", "Bearer secret-bbb"]);
  });

  it("secret 未变时仍复用,不做无谓重建", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const same = () =>
      config({
        clash: {
          enabled: true,
          bridges: [
            {
              id: "b1",
              name: "内核",
              apiBase: "http://127.0.0.1:9090",
              apiSecret: "secret-aaa",
              localProxyPort: 7890,
            },
          ],
          activeBridgeId: "b1",
        },
      });

    expect(svc.controllerFor(same(), "b1")).toBe(svc.controllerFor(same(), "b1"));
  });
});

describe("出口池代际切换", () => {
  it("旧依赖在下一次尝试时取新池，旧池立即开始释放", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const cfg = config();
    const oldDeps = svc.upstreamDeps(cfg);
    const oldPool = oldDeps.dispatchers;
    const oldDispatcher = oldPool.get({ mode: "none" });
    const close = vi.spyOn(oldDispatcher, "close");

    svc.updateTimeouts({ headersTimeoutMs: 1_000, bodyTimeoutMs: 1_000 });

    expect(close).toHaveBeenCalled();
    expect(() => oldPool.get({ mode: "none" })).toThrow("已关闭");
    expect(oldDeps.dispatchers).not.toBe(oldPool);
    expect(oldDeps.config).toBe(cfg);

    const response = await fetchUpstream(
      {
        url: echo,
        method: "GET",
        headers: {},
        body: null,
        proxyId: null,
      },
      oldDeps,
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("198.51.100.5");
  });

  it("同一重试链中切换超时后第二个 Worker 仍能发出真实请求", async () => {
    const seen: Array<string | undefined> = [];
    const echo = await serve((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(seen.length === 1 ? 503 : 200).end("198.51.100.5");
    });
    const svc = egress(echo);
    const result = await runRetryChain({
      targets: ["w1", "w2"].map((id) => ({ workerId: id, apiKey: `fake-key-${id}`, proxyId: null })),
      maxAttempts: 2,
      url: echo,
      method: "POST",
      body: new Uint8Array(),
      buildHeaders: (target) => ({ authorization: `Bearer ${target.apiKey}` }),
      deps: svc.upstreamDeps(config()),
      onAttempt: (record) => {
        if (record.failure !== null) {
          svc.updateTimeouts({ headersTimeoutMs: 1_000, bodyTimeoutMs: 1_000 });
        }
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["Bearer fake-key-w1", "Bearer fake-key-w2"]);
    await expect(result.response?.text()).resolves.toBe("198.51.100.5");
  });

  it("旧流继续读取，停机等待旧池并禁止创建新池", async () => {
    const stream = deferred<ServerResponse>();
    const echo = await serve((_req, res) => {
      res.writeHead(200);
      res.write("first-");
      stream.resolve(res);
    });
    const svc = egress(echo);
    const cfg = config();
    const deps = svc.upstreamDeps(cfg);
    const response = await fetchUpstream({ url: echo, method: "GET", headers: {}, body: null, proxyId: null }, deps);
    const writer = await stream.promise;
    try {
      svc.updateTimeouts({ headersTimeoutMs: 1_000, bodyTimeoutMs: 1_000 });
      const closing = svc.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      await setImmediate();
      expect(closed).toBe(false);
      expect(svc.close()).toBe(closing);
      expect(() => svc.updateTimeouts(TIMEOUTS)).toThrow("已关闭");
      await expect(svc.reset()).rejects.toThrow("已关闭");
      expect(() => svc.upstreamDeps(cfg)).toThrow("已关闭");
      expect(() => svc.controllerFor(cfg, "b1")).toThrow("已关闭");
      await expect(svc.probeProxy(cfg, null)).rejects.toThrow("已关闭");
      writer.end("last");
      await expect(response.text()).resolves.toBe("first-last");
      await closing;
    } finally {
      writer.end();
    }
  });

  it.each(["转发", "探测"])("%s 等待 selector 时换池仍能发出请求", async (kind) => {
    const selecting = deferred<void>();
    const release = deferred<void>();
    const api = await serve((_req, res) => {
      selecting.resolve();
      void release.promise.then(() => res.writeHead(204).end());
    });
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const svc = egress(echo);
    const cfg = config({
      clash: {
        enabled: true,
        activeBridgeId: "b1",
        bridges: [{ id: "b1", name: "假内核", apiBase: api, localProxyPort: Number(new URL(echo).port) }],
      },
      proxies: [{ id: "p1", name: "假节点", type: "vless", host: "proxy.invalid", port: 443, source: "controller", bridgeable: true, bridgeId: "b1" }],
    });
    const pending = kind === "转发"
      ? fetchUpstream({ url: echo, method: "GET", headers: {}, body: null, proxyId: "p1" }, svc.upstreamDeps(cfg)).then(async (response) => ({ ok: response.ok, text: await response.text() }))
      : svc.probeProxy(cfg, "p1").then(({ outcome }) => ({ ok: outcome.ok, text: outcome.ok ? outcome.egressIp : outcome.reason }));
    try {
      await selecting.promise;
      await svc.reset();
    } finally {
      release.resolve();
    }
    expect(await pending).toEqual({ ok: true, text: "198.51.100.5" });
  });
});

describe("probeAll", () => {
  it("并发探测多个代理,每个都有结果", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const results = await egress(echo).probeAll(config(), [null, null, null], 2);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.outcome.ok)).toBe(true);
  });

  it("一个失败不影响其余", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    const results = await egress(echo).probeAll(config(), [null, "不存在", null]);

    expect(results.filter((r) => r.outcome.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.outcome.ok)).toHaveLength(1);
  });

  it("空列表返回空结果", async () => {
    const echo = await serve((_req, res) => res.writeHead(200).end("198.51.100.5"));
    await expect(egress(echo).probeAll(config(), [])).resolves.toEqual([]);
  });

  it("并发上限不超过在途请求数", async () => {
    // 几十个节点同时打向 IP 回显服务会被限流。
    let inFlight = 0;
    let peak = 0;
    const echo = await serve((_req, res) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200).end("198.51.100.5");
      }, 20);
    });

    await egress(echo).probeAll(config(), Array.from({ length: 8 }, () => null), 3);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("applyProbeResult", () => {
  const proxy = ProxySchema.parse({
    id: "p1",
    name: "节点",
    type: "socks5",
    host: "192.0.2.10",
    port: 1080,
    source: "manual",
    direct: true,
    egressIp: "198.51.100.1",
  });

  it("成功时记下实测 IP", () => {
    const next = applyProbeResult(proxy, {
      ok: true,
      egressIp: "203.0.113.9",
      latencyMs: 12,
      via: "x",
    });
    expect(next.egressIp).toBe("203.0.113.9");
  });

  it("失败时不清空已有的 IP", () => {
    /*
     * 一次网络抖动不该让「这个代理的出口是什么」这条已知事实消失,
     * 否则出口隔离视图会在每次抖动时把已确认隔离的节点退回「未知」。
     */
    const next = applyProbeResult(proxy, {
      ok: false,
      failureKind: "transport",
      reason: "连接被拒",
    });
    expect(next.egressIp).toBe("198.51.100.1");
  });

  it("不修改原对象", () => {
    applyProbeResult(proxy, { ok: true, egressIp: "203.0.113.9", latencyMs: 1, via: "x" });
    expect(proxy.egressIp).toBe("198.51.100.1");
  });
});
