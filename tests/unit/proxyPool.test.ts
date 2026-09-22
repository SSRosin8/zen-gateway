import { describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import {
  bridgeNodeName,
  bridgeSelectorGroup,
  describeResolveFailure,
  pickBridge,
  resolveProxy,
} from "../../src/core/proxy/pool.ts";

/** 造一份合法配置;各用例只改自己关心的部分。 */
function config(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "A".repeat(32) },
    ...overrides,
  });
}

const socksProxy = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `节点 ${id}`,
  type: "socks5",
  host: "192.0.2.10",
  port: 1080,
  source: "manual" as const,
  direct: true,
  ...extra,
});

const vlessProxy = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `节点 ${id}`,
  type: "vless",
  host: "192.0.2.11",
  port: 443,
  source: "manual" as const,
  direct: false,
  bridgeable: true,
  ...extra,
});

const bridge = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `内核 ${id}`,
  apiBase: "http://127.0.0.1:9090",
  localProxyPort: 7890,
  ...extra,
});

describe("resolveProxy", () => {
  it("proxyId 为 null 表示不走代理", () => {
    const r = resolveProxy(config(), null);
    expect(r).toEqual({ ok: true, target: { mode: "none" } });
  });

  it("直连协议走 direct,不绕 Clash", () => {
    // 少一跳,且不受 selector 全局状态影响(桥接必须持锁串行切换)。
    const cfg = config({ proxies: [socksProxy("p1")] });
    const r = resolveProxy(cfg, "p1");
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.mode).toBe("direct");
  });

  it("引用不存在的代理时报错,绝不退回本机直连", () => {
    /*
     * 静默直连意味着这个 Worker 与其他 Worker 共用同一个公网 IP,
     * 而出口隔离正是本项目存在的理由。
     */
    const r = resolveProxy(config(), "不存在");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failure.kind).toBe("not_found");
  });

  it("停用的代理不被解析", () => {
    const cfg = config({ proxies: [socksProxy("p1", { enabled: false })] });
    const r = resolveProxy(cfg, "p1");
    expect(r.ok === false && r.failure.kind).toBe("disabled");
  });

  it("仅可桥接的代理在 Clash 未启用时报错", () => {
    // schema 已在加载期拦住这种配置,这里是运行期兜底。
    const cfg = config({
      clash: { enabled: false },
      proxies: [vlessProxy("p1", { enabled: false })],
    });
    const r = resolveProxy(cfg, "p1");
    expect(r.ok).toBe(false);
  });

  it("仅可桥接的代理在 Clash 启用时走 bridge", () => {
    const cfg = config({
      clash: { enabled: true, bridges: [bridge("b1")], activeBridgeId: "b1" },
      proxies: [vlessProxy("p1", { bridgeId: "b1" })],
    });
    const r = resolveProxy(cfg, "p1");
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.mode).toBe("bridge");
    expect(r.ok && r.target.mode === "bridge" && r.target.bridge.port).toBe(7890);
  });

  it("既不能直连也不能桥接时报 unusable", () => {
    const cfg = config({
      proxies: [
        {
          id: "p1",
          name: "怪协议",
          type: "wireguard",
          host: "192.0.2.12",
          port: 51820,
          source: "manual",
          direct: true, // 声明能直连,但协议并不支持
          bridgeable: false,
        },
      ],
    });
    const r = resolveProxy(cfg, "p1");
    // direct=true 但协议不在可直连集合里 —— 不能假装能用。
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.failure.kind).toBe("unusable");
  });

  it("每种失败都有中文说明", () => {
    for (const failure of [
      { kind: "not_found" as const, proxyId: "p" },
      { kind: "disabled" as const, proxyId: "p" },
      { kind: "clash_disabled" as const, proxyId: "p" },
      { kind: "no_bridge" as const, proxyId: "p" },
      { kind: "unusable" as const, proxyId: "p", type: "vless" },
    ]) {
      expect(describeResolveFailure(failure).length).toBeGreaterThan(0);
    }
  });
});

describe("pickBridge", () => {
  it("Clash 未启用时返回 null", () => {
    expect(pickBridge(config().clash)).toBeNull();
  });

  it("manual 模式严格用选中的内核", () => {
    const clash = config({
      clash: {
        enabled: true,
        selectionMode: "manual",
        bridges: [bridge("b1", { priority: 10 }), bridge("b2", { localProxyPort: 7891 })],
        activeBridgeId: "b2",
      },
    }).clash;
    // 即便 b1 的 priority 更优,manual 也必须用 b2。
    expect(pickBridge(clash)?.bridgeId).toBe("b2");
  });

  it("manual 模式下选中的内核被停用时返回 null,不悄悄换一个", () => {
    /*
     * 悄悄换一个会让「我明明指定了内核」变成一个无从察觉的偏差 ——
     * 出口从预期之外的内核出去,而 UI 上看不出任何异常。
     */
    const clash = config({
      clash: {
        enabled: true,
        selectionMode: "manual",
        bridges: [bridge("b1"), bridge("b2", { enabled: false, localProxyPort: 7891 })],
        activeBridgeId: "b2",
      },
    }).clash;
    expect(pickBridge(clash)).toBeNull();
  });

  it("auto 模式按 priority 取最优", () => {
    const clash = config({
      clash: {
        enabled: true,
        selectionMode: "auto",
        bridges: [
          bridge("slow", { priority: 200 }),
          bridge("fast", { priority: 5, localProxyPort: 7891 }),
        ],
      },
    }).clash;
    expect(pickBridge(clash)?.bridgeId).toBe("fast");
  });

  it("auto 模式优先沿用上次健康的内核", () => {
    const clash = config({
      clash: {
        enabled: true,
        selectionMode: "auto",
        bridges: [
          bridge("best", { priority: 1 }),
          bridge("remembered", { priority: 100, localProxyPort: 7891 }),
        ],
        activeBridgeId: "remembered",
      },
    }).clash;
    // 沿用已验证可用的,避免反复在内核之间跳。
    expect(pickBridge(clash)?.bridgeId).toBe("remembered");
  });

  it("全部内核停用时返回 null", () => {
    const clash = config({
      clash: { enabled: true, bridges: [bridge("b1", { enabled: false })] },
    }).clash;
    expect(pickBridge(clash)).toBeNull();
  });

  it("priority 相同时按 id 稳定排序", () => {
    const clash = config({
      clash: {
        enabled: true,
        bridges: [bridge("zeta"), bridge("alpha", { localProxyPort: 7891 })],
      },
    }).clash;
    // 稳定性本身是要求:否则每次重启可能换内核。
    expect(pickBridge(clash)?.bridgeId).toBe("alpha");
  });
});

describe("bridgeNodeName", () => {
  it("优先用 clashNodeName", () => {
    // 从订阅导入时两者可能不同,而 selector 只认 Clash 自己的节点名。
    const proxy = ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: "A".repeat(32) },
      clash: { enabled: true, bridges: [bridge("b1")], activeBridgeId: "b1" },
      proxies: [vlessProxy("p1", { name: "我的叫法", clashNodeName: "Clash 里的名字", bridgeId: "b1" })],
    }).proxies[0]!;
    expect(bridgeNodeName(proxy)).toBe("Clash 里的名字");
  });

  it("没有 clashNodeName 时回落到 name", () => {
    const proxy = ConfigSchema.parse({
      version: 1,
      gateway: { relayToken: "A".repeat(32) },
      clash: { enabled: true, bridges: [bridge("b1")], activeBridgeId: "b1" },
      proxies: [vlessProxy("p1", { name: "只有这个名字", bridgeId: "b1" })],
    }).proxies[0]!;
    expect(bridgeNodeName(proxy)).toBe("只有这个名字");
  });
});

describe("bridgeSelectorGroup", () => {
  it("取所属内核配置的分组", () => {
    const clash = config({
      clash: { enabled: true, bridges: [bridge("b1", { selectorGroup: "Proxy" })] },
    }).clash;
    expect(bridgeSelectorGroup(clash, "b1")).toBe("Proxy");
  });

  it("内核不存在时返回 null", () => {
    expect(bridgeSelectorGroup(config().clash, "没有")).toBeNull();
  });
});
