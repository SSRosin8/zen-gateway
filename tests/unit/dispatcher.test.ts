import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetch } from "undici";
import {
  DispatcherError,
  DispatcherPool,
  isDirectCapable,
  type EgressTarget,
} from "../../src/core/proxy/dispatcher.ts";
import { ProxySchema, type Proxy } from "../../src/shared/schema.ts";

const TIMEOUTS = { headersTimeoutMs: 5_000, bodyTimeoutMs: 30_000 };

const proxy = (extra: Record<string, unknown> = {}): Proxy =>
  ProxySchema.parse({
    id: "p1",
    name: "节点甲",
    type: "socks5",
    host: "192.0.2.10",
    port: 1080,
    source: "manual",
    direct: true,
    ...extra,
  });

const pools: DispatcherPool[] = [];
const servers: Server[] = [];

function pool(timeouts = TIMEOUTS): DispatcherPool {
  const p = new DispatcherPool(timeouts);
  pools.push(p);
  return p;
}

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((p) => p.close()));
  await Promise.allSettled(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

describe("isDirectCapable", () => {
  it.each(["http", "https", "socks4", "socks5", "SOCKS5", "HTTP"])("%s 可直连", (type) => {
    expect(isDirectCapable(type)).toBe(true);
  });

  it.each(["vless", "vmess", "hysteria2", "tuic", "anytls", "ss", "trojan"])(
    "%s 只能桥接",
    (type) => {
      expect(isDirectCapable(type)).toBe(false);
    },
  );
});

describe("dispatcher 缓存", () => {
  it("同一代理复用同一个 dispatcher", () => {
    // 每次请求新建会丢掉连接池,高频下还会耗尽本地端口。
    const p = pool();
    const target: EgressTarget = { mode: "direct", proxy: proxy() };
    expect(p.get(target)).toBe(p.get(target));
    expect(p.size).toBe(1);
  });

  it("端口变了就重建,不复用连到旧地址的那个", () => {
    const p = pool();
    const first = p.get({ mode: "direct", proxy: proxy({ port: 1080 }) });
    const second = p.get({ mode: "direct", proxy: proxy({ port: 1081 }) });
    expect(second).not.toBe(first);
    // 仍是同一个 id,所以缓存里只有一个条目。
    expect(p.size).toBe(1);
  });

  it("主机变了就重建", () => {
    const p = pool();
    const first = p.get({ mode: "direct", proxy: proxy({ host: "192.0.2.10" }) });
    const second = p.get({ mode: "direct", proxy: proxy({ host: "192.0.2.11" }) });
    expect(second).not.toBe(first);
  });

  it("口令变了就重建 —— 口令参与缓存键", () => {
    /*
     * 只用 proxy.id 作键的话,用户改了口令后仍会复用旧 dispatcher,
     * 继续用错误的凭证连接。
     */
    const p = pool();
    const first = p.get({ mode: "direct", proxy: proxy({ username: "u", password: "old-secret" }) });
    const second = p.get({
      mode: "direct",
      proxy: proxy({ username: "u", password: "different-length-secret" }),
    });
    expect(second).not.toBe(first);
  });

  it("协议变了就重建", () => {
    const p = pool();
    const first = p.get({ mode: "direct", proxy: proxy({ type: "socks5" }) });
    const second = p.get({ mode: "direct", proxy: proxy({ type: "http" }) });
    expect(second).not.toBe(first);
  });

  it("超时配置不同的池各自独立", () => {
    const a = pool({ headersTimeoutMs: 1_000, bodyTimeoutMs: 2_000 });
    const b = pool({ headersTimeoutMs: 9_000, bodyTimeoutMs: 9_000 });
    expect(a.get({ mode: "direct", proxy: proxy() })).not.toBe(
      b.get({ mode: "direct", proxy: proxy() }),
    );
  });

  it("不同代理各占一个条目", () => {
    const p = pool();
    p.get({ mode: "direct", proxy: proxy({ id: "p1" }) });
    p.get({ mode: "direct", proxy: proxy({ id: "p2" }) });
    expect(p.size).toBe(2);
  });

  it("mode=none 复用同一个本机出口 dispatcher", () => {
    const p = pool();
    expect(p.get({ mode: "none" })).toBe(p.get({ mode: "none" }));
    expect(p.size).toBe(1);
  });

  it("桥接模式按内核与本地端口缓存", () => {
    const p = pool();
    const base = { mode: "bridge" as const, proxy: proxy({ type: "vless", direct: false, bridgeable: true }) };
    const first = p.get({ ...base, bridge: { bridgeId: "b1", host: "127.0.0.1", port: 7890 } });
    const same = p.get({ ...base, bridge: { bridgeId: "b1", host: "127.0.0.1", port: 7890 } });
    const other = p.get({ ...base, bridge: { bridgeId: "b1", host: "127.0.0.1", port: 7891 } });

    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("协议支持", () => {
  it.each(["socks4", "socks5"])("%s 直连可建 dispatcher", (type) => {
    const p = pool();
    expect(() => p.get({ mode: "direct", proxy: proxy({ type }) })).not.toThrow();
  });

  it.each(["http", "https"])("%s 直连可建 dispatcher", (type) => {
    const p = pool();
    expect(() => p.get({ mode: "direct", proxy: proxy({ type, port: 8080 }) })).not.toThrow();
  });

  it("带认证的 socks 可建 dispatcher", () => {
    const p = pool();
    expect(() =>
      p.get({ mode: "direct", proxy: proxy({ username: "u", password: "p" }) }),
    ).not.toThrow();
  });

  it("只能桥接的协议在 direct 模式下抛 DispatcherError", () => {
    const p = pool();
    const err = (() => {
      try {
        p.get({ mode: "direct", proxy: proxy({ type: "vless", bridgeable: true }) });
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(DispatcherError);
    expect((err as DispatcherError).proxyId).toBe("p1");
    expect((err as DispatcherError).message).toContain("桥接");
  });
});

describe("生命周期", () => {
  it("reset 清空缓存", async () => {
    const p = pool();
    p.get({ mode: "direct", proxy: proxy() });
    expect(p.size).toBe(1);
    await p.reset();
    expect(p.size).toBe(0);
  });

  it("close 之后拒绝再取", async () => {
    const p = pool();
    await p.close();
    expect(() => p.get({ mode: "none" })).toThrow(DispatcherError);
  });

  it("reset 后可继续使用", async () => {
    const p = pool();
    await p.reset();
    expect(() => p.get({ mode: "none" })).not.toThrow();
  });
});

describe("超时确实生效", () => {
  it("headersTimeout 掐断迟迟不发响应头的上游", async () => {
    /*
     * 这条与下一条一起构成不变量 #6 的证据:
     * 等首字节可以严格,而流式输出的块间隔必须宽松 —— 用单一总时长
     * (如 AbortSignal.timeout 套整个 fetch)会把正常的长 SSE 一起掐断。
     */
    const server = createServer((_req, res) => {
      setTimeout(() => res.writeHead(200).end("late"), 3_000);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;

    const p = pool({ headersTimeoutMs: 500, bodyTimeoutMs: 30_000 });
    const dispatcher = p.get({ mode: "none" });

    const started = Date.now();
    await expect(fetch(url, { dispatcher })).rejects.toThrow();
    // 应当在 headersTimeout 附近失败,而不是等满 3s。
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("块间隔远小于 bodyTimeout 的流式响应能完整读完", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 600);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;

    // headersTimeout 很短但 bodyTimeout 宽松 —— 长流必须活下来。
    const p = pool({ headersTimeoutMs: 500, bodyTimeoutMs: 30_000 });
    const res = await fetch(url, { dispatcher: p.get({ mode: "none" }) });
    const text = await res.text();

    expect(text).toContain("first");
    expect(text).toContain("second");
  });
});
