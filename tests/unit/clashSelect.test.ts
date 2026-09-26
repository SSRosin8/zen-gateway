import { describe, expect, it } from "vitest";
import {
  lockedBridgeFor,
  probeBridges,
  selectBridge,
  type BridgeHealth,
} from "../../src/core/proxy/clash/select.ts";
import { ClashConfigSchema, type ClashBridge, type ClashConfig } from "../../src/shared/schema.ts";

/*
 * 多 Clash 内核的候选与择优。
 *
 * `pickBridge`（`pool.ts`）已经会选，但它是**纯配置推导** —— 它从不知道
 * 内核是否活着。auto 模式注释里那个"健康"此前没有任何东西去测量，
 * 于是实际行为是"永远用同一个，它挂了也不换"。这里补上测量与择优。
 */

function bridge(over: Partial<ClashBridge> & { id: string }): ClashBridge {
  return {
    name: `内核 ${over.id}`,
    enabled: true,
    priority: 100,
    apiBase: `http://127.0.0.1:9097`,
    apiSecret: "",
    localProxyHost: "127.0.0.1",
    localProxyPort: 7897,
    selectorGroup: "Proxy",
    ...over,
  };
}

function clash(over: Partial<ClashConfig> = {}): ClashConfig {
  return ClashConfigSchema.parse({ enabled: true, bridges: [], ...over });
}

const healthy = (id: string, nodes = 5): BridgeHealth => ({
  bridgeId: id,
  alive: true,
  version: "1.19.31",
  usableNodes: nodes,
  reason: null,
});

const dead = (id: string, reason = "connect ECONNREFUSED"): BridgeHealth => ({
  bridgeId: id,
  alive: false,
  version: null,
  usableNodes: 0,
  reason,
});

/** 连得上但分组里没节点 —— 本机真实踩过的形态。 */
const emptyGroup = (id: string): BridgeHealth => ({
  bridgeId: id,
  alive: true,
  version: "1.19.31",
  usableNodes: 0,
  reason: "分组 Proxy 里没有节点",
});

describe("auto 模式择优", () => {
  it("按 priority 选，小者优先", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b-slow", priority: 200 }), bridge({ id: "b-fast", priority: 10 })],
    });
    const out = selectBridge(cfg, [healthy("b-slow"), healthy("b-fast")]);
    expect(out.bridgeId).toBe("b-fast");
    expect(out.changed).toBe(true);
  });

  it("**粘滞**：当前内核仍可用就不换，哪怕别的 priority 更小", () => {
    /*
     * 换内核意味着换本地代理端口 → dispatcher 全部重建，而更要紧的是
     * 会话亲和的语义会变（同一个 Worker 换内核后走另一条物理链路，
     * 出口 IP 可能变，而上游的加密推理块是按出口签发的）。
     * 所以只在当前那个不可用时才换。
     */
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: "b-current",
      bridges: [bridge({ id: "b-current", priority: 200 }), bridge({ id: "b-better", priority: 10 })],
    });
    const out = selectBridge(cfg, [healthy("b-current"), healthy("b-better")]);
    expect(out.bridgeId).toBe("b-current");
    expect(out.changed).toBe(false);
    expect(out.reason).toContain("保持当前内核");
  });

  it("当前内核死了就切到次优，并标记需要写盘", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: "b-dead",
      bridges: [bridge({ id: "b-dead", priority: 10 }), bridge({ id: "b-alive", priority: 200 })],
    });
    const out = selectBridge(cfg, [dead("b-dead"), healthy("b-alive")]);
    expect(out.bridgeId).toBe("b-alive");
    // 真的换了才写盘 —— 每次探活都写会让 config.json 无谓地反复原子写。
    expect(out.changed).toBe(true);
    expect(out.reason).toContain("自动切换");
  });

  it("**连得上但分组里没节点**的内核不算可用", () => {
    /*
     * 这是本机踩过的形态：`selectorGroup` 名字写错、或分组被改过。
     * Controller 答得好好的，而选中它之后每个桥接代理都失败 ——
     * 只看 alive 会把它选出来。
     */
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b-empty", priority: 10 }), bridge({ id: "b-ok", priority: 200 })],
    });
    const out = selectBridge(cfg, [emptyGroup("b-empty"), healthy("b-ok")]);
    expect(out.bridgeId).toBe("b-ok");
  });

  it("停用的内核不参与 —— 哪怕它探活是健康的", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b-off", enabled: false, priority: 1 }), bridge({ id: "b-on", priority: 100 })],
    });
    const out = selectBridge(cfg, [healthy("b-off"), healthy("b-on")]);
    expect(out.bridgeId).toBe("b-on");
  });

  it("全部不可用时**保留** activeBridgeId，不清成 null", () => {
    /*
     * 清成 null 会让"Clash 整个挂了一分钟"变成"用户的内核选择被抹掉"，
     * 而恢复之后它不会自己回来 —— 用信息丢失去表达一个临时状态。
     */
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: "b1",
      bridges: [bridge({ id: "b1" }), bridge({ id: "b2" })],
    });
    const out = selectBridge(cfg, [dead("b1"), dead("b2")]);
    expect(out.bridgeId).toBe("b1");
    expect(out.changed).toBe(false);
    expect(out.reason).toContain("全部探活失败");
  });

  it("「连得上但没节点」与「连不上」的理由不同", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b1" })],
    });
    expect(selectBridge(cfg, [emptyGroup("b1")]).reason).toContain("没有可用节点");
    expect(selectBridge(cfg, [dead("b1")]).reason).toContain("探活失败");
  });

  it("`changed` 只在真的换了时为 true —— 粘滞与全挂两条都必须是 false", () => {
    /*
     * 每次探活都写盘会让 config.json 无谓地反复原子写，而它是唯一一份
     * 凭证存储。所以 `changed` 的语义必须是"真的换了"。
     *
     * 变异测试的一个副产物：把重新择优那行的 `changed` 改成恒 true
     * **没有任何断言会红** —— 而那不是缺测试，是那行本身是死信息：
     * 走到那里意味着当前内核不在 usable 里（可用的话粘滞已经返回了），
     * 而 best 取自 usable，两者不可能相同。已把源码改成直接写 true 并注明。
     *
     * 真正需要钉住的是**返回 false 的那两条路径**：
     */
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: "b1",
      bridges: [bridge({ id: "b1", priority: 100 }), bridge({ id: "b2", priority: 1 })],
    });

    // 一、粘滞：当前那个可用 → 不换，即使 b2 的 priority 更小。
    expect(selectBridge(cfg, [healthy("b1"), healthy("b2")]).changed).toBe(false);
    // 二、全部不可用 → 保留当前，也不算"换了"。
    expect(selectBridge(cfg, [dead("b1"), dead("b2")]).changed).toBe(false);
    // 三、当前那个不可用而另一个可用 → 这才是真的换了。
    expect(selectBridge(cfg, [dead("b1"), healthy("b2")]).changed).toBe(true);
  });

  it("同 priority 时按 id 字典序 —— 两次跑结果一致", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b-zzz", priority: 50 }), bridge({ id: "b-aaa", priority: 50 })],
    });
    const first = selectBridge(cfg, [healthy("b-zzz"), healthy("b-aaa")]);
    const second = selectBridge(cfg, [healthy("b-aaa"), healthy("b-zzz")]);
    expect(first.bridgeId).toBe("b-aaa");
    // 探活结果的顺序不该影响决定。
    expect(second.bridgeId).toBe(first.bridgeId);
  });

  it("没探活过的内核（health 里没有它）不算可用", () => {
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: null,
      bridges: [bridge({ id: "b-unprobed", priority: 1 }), bridge({ id: "b-probed", priority: 100 })],
    });
    // 「不知道」不等于「能用」—— 那是整个项目反复出现的一条。
    expect(selectBridge(cfg, [healthy("b-probed")]).bridgeId).toBe("b-probed");
  });
});

describe("manual 模式不自动切换", () => {
  it("选中的内核死了也不换 —— 只如实报告", () => {
    /*
     * 悄悄换一个会让「我明明选了这个内核」变成一个无从察觉的偏差。
     * `pickBridge` 的判断也是这样，两处一致。
     */
    const cfg = clash({
      selectionMode: "manual",
      activeBridgeId: "b-chosen",
      bridges: [bridge({ id: "b-chosen" }), bridge({ id: "b-other" })],
    });
    const out = selectBridge(cfg, [dead("b-chosen"), healthy("b-other")]);
    expect(out.bridgeId).toBe("b-chosen");
    expect(out.changed).toBe(false);
    expect(out.reason).toContain("不自动切换");
    // 原因要带上，否则用户不知道为什么桥接不通。
    expect(out.reason).toContain("ECONNREFUSED");
  });

  it("选中的内核健康时正常返回", () => {
    const cfg = clash({
      selectionMode: "manual",
      activeBridgeId: "b1",
      bridges: [bridge({ id: "b1" })],
    });
    expect(selectBridge(cfg, [healthy("b1")]).bridgeId).toBe("b1");
  });

  it("manual 但没选中任何内核时说清楚", () => {
    const cfg = clash({
      selectionMode: "manual",
      activeBridgeId: null,
      bridges: [bridge({ id: "b1" })],
    });
    const out = selectBridge(cfg, [healthy("b1")]);
    expect(out.bridgeId).toBeNull();
    expect(out.reason).toContain("没有选中内核");
  });
});

describe("边界", () => {
  it("Clash 未启用时直接给 null", () => {
    const cfg = clash({ enabled: false, bridges: [bridge({ id: "b1" })] });
    expect(selectBridge(cfg, [healthy("b1")]).bridgeId).toBeNull();
  });

  it("没有启用的内核时给 null 且说明", () => {
    const cfg = clash({ bridges: [bridge({ id: "b1", enabled: false })] });
    const out = selectBridge(cfg, [healthy("b1")]);
    expect(out.bridgeId).toBeNull();
    expect(out.reason).toContain("没有启用");
  });
});

describe("批测锁定单内核", () => {
  it("给出批测该用的内核", () => {
    /*
     * 不变量 #5 的延伸：桥接探测要切 selector，而 selector 是进程外的
     * 全局状态。一批探测跑到一半换了内核，后半批量到的是另一个内核的出口
     * —— 而隔离报告把两批混在一起按 IP 分组。
     */
    const cfg = clash({
      selectionMode: "auto",
      activeBridgeId: "b1",
      bridges: [bridge({ id: "b1" }), bridge({ id: "b2" })],
    });
    const locked = lockedBridgeFor(cfg, [healthy("b1"), healthy("b2")]);
    expect(locked.bridgeId).toBe("b1");
    expect(locked.reason).toContain("批测锁定");
  });

  it("一个都不可用时明确说批测无法进行", () => {
    const cfg = clash({ selectionMode: "auto", activeBridgeId: null, bridges: [bridge({ id: "b1" })] });
    const locked = lockedBridgeFor(cfg, [dead("b1")]);
    expect(locked.reason).toContain("批测无法进行");
  });
});

describe("探活", () => {
  const probeOf =
    (behavior: Record<string, "ok" | "dead" | "no-group" | "empty" | "proxies-fail">) =>
    (b: ClashBridge) => ({
      bridgeId: b.id,
      version: async () => {
        if (behavior[b.id] === "dead") throw new Error("connect ECONNREFUSED 127.0.0.1:9097");
        return { version: "1.19.31", isMeta: true };
      },
      selectors: async () => {
        if (behavior[b.id] === "proxies-fail") throw new Error("读取失败");
        if (behavior[b.id] === "no-group") return [{ name: "别的分组", now: "x", options: ["x"] }];
        if (behavior[b.id] === "empty") return [{ name: "Proxy", now: "", options: [] }];
        return [{ name: "Proxy", now: "n1", options: ["n1", "n2", "n3"] }];
      },
    });

  it("并发探活多个内核，各自的结局独立", async () => {
    const bridges = [bridge({ id: "b-ok" }), bridge({ id: "b-dead" }), bridge({ id: "b-empty" })];
    const health = await probeBridges(
      bridges,
      probeOf({ "b-ok": "ok", "b-dead": "dead", "b-empty": "empty" }),
    );

    const byId = new Map(health.map((h) => [h.bridgeId, h]));
    expect(byId.get("b-ok")).toMatchObject({ alive: true, usableNodes: 3, reason: null });
    expect(byId.get("b-dead")).toMatchObject({ alive: false, usableNodes: 0 });
    // 一个内核挂掉不影响别的 —— 探活是只读的，所以能并发。
    expect(byId.get("b-empty")).toMatchObject({ alive: true, usableNodes: 0 });
  });

  it("**按 `selectorGroup` 数节点**，不是按全部节点", async () => {
    /*
     * 转发只走那个分组。按总数判定会选中一个"节点很多但我们用的那个分组
     * 是空的"内核 —— 而那时每个桥接代理都失败。
     */
    const health = await probeBridges([bridge({ id: "b1" })], probeOf({ b1: "no-group" }));
    expect(health[0]).toMatchObject({ alive: true, usableNodes: 0 });
    expect(health[0]!.reason).toContain("没有名为 Proxy 的 selector 分组");
  });

  it("`/version` 过了而 `/proxies` 没过 → 不算活着", async () => {
    const health = await probeBridges([bridge({ id: "b1" })], probeOf({ b1: "proxies-fail" }));
    // "能出口"是这里唯一有意义的判据。
    expect(health[0]!.alive).toBe(false);
    expect(health[0]!.version).toBe("1.19.31");
    expect(health[0]!.reason).toContain("读取节点列表失败");
  });

  it("探活结果直接喂给 selectBridge 能选出内核（两层接得上）", async () => {
    const bridges = [bridge({ id: "b-dead", priority: 1 }), bridge({ id: "b-ok", priority: 2 })];
    const cfg = clash({ selectionMode: "auto", activeBridgeId: "b-dead", bridges });
    const health = await probeBridges(bridges, probeOf({ "b-dead": "dead", "b-ok": "ok" }));

    const out = selectBridge(cfg, health);
    expect(out.bridgeId).toBe("b-ok");
    expect(out.changed).toBe(true);
  });

  it("错误消息过脱敏函数 —— secret 不进探活结果", async () => {
    const health = await probeBridges(
      [bridge({ id: "b1", apiSecret: "super-secret-value" })],
      (b) => ({
        bridgeId: b.id,
        version: async () => {
          throw new Error(`auth failed with token super-secret-value`);
        },
        selectors: async () => [],
      }),
      { redact: (err) => String(err instanceof Error ? err.message : err).replace(/super-secret-value/g, "***") },
    );
    expect(health[0]!.reason).not.toContain("super-secret-value");
  });
});
