import { describe, expect, it } from "vitest";
import { ConfigSchema, CONFIG_VERSION, IdSchema } from "../../src/shared/schema.ts";
import {
  bridgeIdFor,
  CANDIDATE_PORTS,
  mergeControllerImport,
  pickSelector,
  proxyIdFor,
  type ControllerPlan,
} from "../../src/core/proxy/clash/setupImport.ts";

// `setup.mjs` 与 `/api/clash/*` 共用的纯函数部分。

const base = () => ConfigSchema.parse({ version: CONFIG_VERSION, gateway: { relayToken: "setup-import-token-xx" } });

function plan(overrides: Partial<ControllerPlan> = {}): ControllerPlan {
  const nodes = [
    { name: "🇯🇵 东京 01", type: "AnyTLS", latencyMs: null },
    { name: "分组外节点", type: "Vless", latencyMs: null },
  ];
  return {
    apiBase: "http://127.0.0.1:9097",
    secret: "",
    isMeta: true,
    mode: "rule",
    mixedPort: 7897,
    selector: { name: "Proxy", now: "", options: ["🇯🇵 东京 01"] },
    usable: 1,
    nodes,
    otherSelectors: [],
    warnings: [],
    ...overrides,
  };
}

describe("setupImport", () => {
  it("候选端口是小的固定白名单", () => {
    expect(CANDIDATE_PORTS.length).toBeLessThanOrEqual(8);
  });

  it("id 稳定且合法，含 IPv6 回环", () => {
    expect(proxyIdFor("节点 A")).toBe(proxyIdFor("节点 A"));
    expect(IdSchema.safeParse(proxyIdFor("🇯🇵 东京 01")).success).toBe(true);
    expect(bridgeIdFor("http://127.0.0.1:9097")).toBe("bridge-127.0.0.1-9097");
    expect(IdSchema.safeParse(bridgeIdFor("http://[::1]:9090")).success).toBe(true);
  });

  it("只导入所选分组里的节点，不创建 Worker", () => {
    const merged = mergeControllerImport(base(), [plan()]);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.next.proxies.map((p) => p.clashNodeName)).toEqual(["🇯🇵 东京 01"]);
    expect(merged.next.workers).toEqual([]);
    expect(merged.next.clash.activeBridgeId).toBe("bridge-127.0.0.1-9097");
  });

  it("不改入参（Scheduler 按引用判断配置变化）", () => {
    const config = base();
    const snapshot = structuredClone(config);
    mergeControllerImport(config, [plan()]);
    expect(config).toEqual(snapshot);
  });

  it("rule 模式下兜底目标优先，GLOBAL 排最后", () => {
    const nodes = [{ name: "n", type: "AnyTLS", latencyMs: null }];
    const selectors = [
      { name: "GLOBAL", now: "", options: ["n"] },
      { name: "Partial", now: "", options: ["n"] },
      { name: "Fallback", now: "", options: ["n"] },
    ];
    const routed = { targets: new Map([["Partial", 1], ["Fallback", 1]]), fallback: "Fallback" };
    expect(pickSelector(selectors, nodes, "rule", routed)?.selector.name).toBe("Fallback");
    expect(pickSelector(selectors, nodes, "rule", null)?.selector.name).toBe("Fallback");
    expect(pickSelector(selectors, nodes, "global", routed)?.selector.name).toBe("GLOBAL");
  });
});
