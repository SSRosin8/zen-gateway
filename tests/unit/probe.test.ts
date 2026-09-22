import { describe, expect, it } from "vitest";
import { Agent } from "undici";
import { createServer, type Server } from "node:http";
import {
  buildIsolationReport,
  isIpAddress,
  probeEgress,
  type IpEchoService,
} from "../../src/core/proxy/probe.ts";
import { SelectorLock } from "../../src/core/proxy/selectorLock.ts";

/** 起一个本机 HTTP 服务并返回其 origin;用真实网络路径而不是 mock fetch。 */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const plainText: IpEchoService["extract"] = (text) => {
  const t = text.trim();
  return isIpAddress(t) ? t : null;
};

describe("isIpAddress", () => {
  it.each(["192.0.2.1", "8.8.8.8", "255.255.255.255", "0.0.0.0", "198.51.100.42"])(
    "接受合法 IPv4 %s",
    (ip) => {
      expect(isIpAddress(ip)).toBe(true);
    },
  );

  it.each(["2001:db8::1", "::1", "fe80::1", "2001:0db8:0000:0000:0000:0000:0000:0001"])(
    "接受合法 IPv6 %s",
    (ip) => {
      expect(isIpAddress(ip)).toBe(true);
    },
  );

  it.each([
    ["空串", ""],
    ["超范围", "256.1.1.1"],
    ["段数不足", "1.2.3"],
    ["前导零", "010.1.1.1"],
    ["一整页 HTML", "<html><body>Your IP is hidden</body></html>"],
    ["带端口", "192.0.2.1:8080"],
    ["CIDR", "192.0.2.0/24"],
    ["主机名", "example.invalid"],
    ["多个 ::", "1::2::3"],
  ])("拒绝 %s", (_label, value) => {
    /*
     * 必须校验:回显服务被劫持或返回 HTML 时,未校验的实现会把整段文本
     * 当成「出口 IP」存进配置,于是隔离判定按一串垃圾分组,看起来全都「不同」。
     */
    expect(isIpAddress(value)).toBe(false);
  });

  it("拒绝过长输入", () => {
    expect(isIpAddress("1".repeat(100))).toBe(false);
  });
});

describe("probeEgress", () => {
  it("取到公网 IP 与延迟", async () => {
    const s = await serve((_req, res) => res.writeHead(200).end("198.51.100.7\n"));
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({
        dispatcher,
        services: [{ url: s.origin, extract: plainText }],
      });
      expect(out.ok).toBe(true);
      expect(out.ok && out.egressIp).toBe("198.51.100.7");
      expect(out.ok && out.via).toBe(s.origin);
      expect(out.ok && out.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await dispatcher.close();
      await s.close();
    }
  });

  it("首个服务失败时回退到下一个", async () => {
    // 单一服务挂掉或被墙会让整个探测功能失效,而它是出口隔离的唯一验证手段。
    const bad = await serve((_req, res) => res.writeHead(500).end("nope"));
    const good = await serve((_req, res) => res.writeHead(200).end("203.0.113.9"));
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({
        dispatcher,
        services: [
          { url: bad.origin, extract: plainText },
          { url: good.origin, extract: plainText },
        ],
      });
      expect(out.ok && out.egressIp).toBe("203.0.113.9");
      expect(out.ok && out.via).toBe(good.origin);
    } finally {
      await dispatcher.close();
      await bad.close();
      await good.close();
    }
  });

  it("响应里没有合法 IP 时视为失败,且不回显响应内容", async () => {
    const html = "<html><head><title>Redirecting…</title></head><body>go to evil.invalid</body></html>";
    const s = await serve((_req, res) => res.writeHead(200).end(html));
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({
        dispatcher,
        services: [{ url: s.origin, extract: plainText }],
      });
      expect(out.ok).toBe(false);
      // 响应体可能是一整页 HTML,也可能含跳转 URL —— 不进 reason。
      expect(out.ok === false && out.reason).not.toContain("evil.invalid");
      expect(out.ok === false && out.reason).not.toContain("<html>");
    } finally {
      await dispatcher.close();
      await s.close();
    }
  });

  it("连接被拒时分类为 transport", async () => {
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({
        dispatcher,
        // 127.0.0.1 上一个几乎肯定没人监听的端口。
        services: [{ url: "http://127.0.0.1:9", extract: plainText }],
        timeoutMs: 2_000,
      });
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.failureKind).toBe("transport");
    } finally {
      await dispatcher.close();
    }
  });

  it("429 分类为 rate_limit", async () => {
    const s = await serve((_req, res) => res.writeHead(429).end("slow down"));
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({ dispatcher, services: [{ url: s.origin, extract: plainText }] });
      expect(out.ok === false && out.failureKind).toBe("rate_limit");
    } finally {
      await dispatcher.close();
      await s.close();
    }
  });

  it("没有可用服务时如实失败", async () => {
    const dispatcher = new Agent();
    try {
      const out = await probeEgress({ dispatcher, services: [] });
      expect(out.ok).toBe(false);
    } finally {
      await dispatcher.close();
    }
  });

  it("桥接模式下先切 selector 再发请求,两者在同一把锁内", async () => {
    const calls: string[] = [];
    const s = await serve((_req, res) => {
      calls.push("fetch");
      res.writeHead(200).end("192.0.2.55");
    });
    const dispatcher = new Agent();
    const lock = new SelectorLock();

    // 只实现 probe 用到的那一个方法。
    const controller = {
      async select(group: string, node: string) {
        calls.push(`select:${group}/${node}`);
      },
    } as unknown as Parameters<typeof probeEgress>[0]["bridge"] extends undefined
      ? never
      : NonNullable<Parameters<typeof probeEgress>[0]["bridge"]>["controller"];

    try {
      const out = await probeEgress({
        dispatcher,
        services: [{ url: s.origin, extract: plainText }],
        bridge: { lock, controller, selectorGroup: "GLOBAL", nodeName: "🇺🇲 节点 A" },
      });
      expect(out.ok).toBe(true);
      // 顺序必须是先切换后请求;反过来就是从上一个节点出去了。
      expect(calls).toEqual(["select:GLOBAL/🇺🇲 节点 A", "fetch"]);
      expect(lock.pending).toBe(0);
    } finally {
      await dispatcher.close();
      await s.close();
    }
  });

  it("桥接模式下并发探测被串行化", async () => {
    /*
     * selector 的 now 是全局状态:两个并发探测各自切换会互相换掉对方的
     * 出口节点,于是两次探测都可能报出同一个 IP —— 看起来「共用出口」,
     * 或更糟,看起来「已隔离」而实际不是。
     */
    const events: string[] = [];
    const s = await serve((_req, res) => {
      setTimeout(() => res.writeHead(200).end("192.0.2.77"), 15);
    });
    const dispatcher = new Agent();
    const lock = new SelectorLock();

    const makeController = (id: string) =>
      ({
        async select() {
          events.push(`${id}-select`);
        },
      }) as unknown as NonNullable<Parameters<typeof probeEgress>[0]["bridge"]>["controller"];

    try {
      await Promise.all(
        ["a", "b"].map((id) =>
          probeEgress({
            dispatcher,
            services: [{ url: s.origin, extract: plainText }],
            bridge: {
              lock,
              controller: makeController(id),
              selectorGroup: "GLOBAL",
              nodeName: `节点-${id}`,
            },
          }).then(() => events.push(`${id}-done`)),
        ),
      );

      // a 的连接必须在 b 切换之前建立完成。
      expect(events.indexOf("a-select")).toBeLessThan(events.indexOf("b-select"));
    } finally {
      await dispatcher.close();
      await s.close();
    }
  });
});

describe("buildIsolationReport", () => {
  it("按实测 egressIp 分组,而不是按 proxyId", () => {
    /*
     * 这是整个功能的核心判定。旧实现按 proxyId 判断是否共用出口,从不比较
     * 实测 IP —— 两个不同代理 NAT 到同一公网 IP 时会被报成「已隔离」,
     * 而隔离恰恰是这个项目存在的理由,判断错了整个功能就是假的。
     */
    const report = buildIsolationReport([
      { workerId: "w1", proxyId: "p1", egressIp: "198.51.100.1" },
      { workerId: "w2", proxyId: "p2", egressIp: "198.51.100.1" },
    ]);

    expect(report.groups).toHaveLength(1);
    expect(report.sharedGroups).toHaveLength(1);
    expect(report.sharedGroups[0]!.workerIds).toEqual(["w1", "w2"]);
    // 两个不同代理落在同一 IP —— 正是「看起来隔离其实没隔离」的形态。
    expect(report.sharedGroups[0]!.proxyIds).toEqual(["p1", "p2"]);
    expect(report.isolated).toBe(false);
  });

  it("不同 IP 视为已隔离", () => {
    const report = buildIsolationReport([
      { workerId: "w1", proxyId: "p1", egressIp: "198.51.100.1" },
      { workerId: "w2", proxyId: "p2", egressIp: "203.0.113.2" },
    ]);
    expect(report.sharedGroups).toHaveLength(0);
    expect(report.isolated).toBe(true);
  });

  it("未探测出 IP 的记录单列为未知,不算已隔离", () => {
    /*
     * 「还不知道」和「确认不同」是两件事,混在一起会给出虚假的安全感。
     */
    const report = buildIsolationReport([
      { workerId: "w1", proxyId: "p1", egressIp: "198.51.100.1" },
      { workerId: "w2", proxyId: "p2", egressIp: null },
    ]);
    expect(report.unknownWorkerIds).toEqual(["w2"]);
    expect(report.sharedGroups).toHaveLength(0);
    expect(report.isolated).toBe(false);
  });

  it("空串 IP 等同于未知", () => {
    const report = buildIsolationReport([{ workerId: "w1", proxyId: null, egressIp: "" }]);
    expect(report.unknownWorkerIds).toEqual(["w1"]);
  });

  it("空输入不算已隔离", () => {
    // 没有 Worker 时谈不上隔离;与 poolHealth 的 empty 第三态同理。
    const report = buildIsolationReport([]);
    expect(report.isolated).toBe(true);
    expect(report.groups).toEqual([]);
  });

  it("同一代理下多个 Worker 也算共用出口", () => {
    const report = buildIsolationReport([
      { workerId: "w1", proxyId: "p1", egressIp: "198.51.100.1" },
      { workerId: "w2", proxyId: "p1", egressIp: "198.51.100.1" },
    ]);
    expect(report.sharedGroups[0]!.workerIds).toEqual(["w1", "w2"]);
    // 同一代理只记一次。
    expect(report.sharedGroups[0]!.proxyIds).toEqual(["p1"]);
  });

  it("直连 Worker 的 proxyId 为 null 时不进 proxyIds", () => {
    const report = buildIsolationReport([
      { workerId: "w1", proxyId: null, egressIp: "198.51.100.1" },
    ]);
    expect(report.groups[0]!.proxyIds).toEqual([]);
    expect(report.groups[0]!.workerIds).toEqual(["w1"]);
  });
});
