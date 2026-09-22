import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { ConfigSchema, ProxySchema, type Config } from "../../src/shared/schema.ts";
import { EgressService, applyProbeResult } from "../../src/core/proxy/egress.ts";
import { isIpAddress, type IpEchoService } from "../../src/core/proxy/probe.ts";

const TIMEOUTS = { headersTimeoutMs: 3_000, bodyTimeoutMs: 10_000 };

const servers: Server[] = [];
const services: EgressService[] = [];

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
