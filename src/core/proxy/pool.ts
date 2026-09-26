import type { ClashConfig, Config, Proxy } from "../../shared/schema.ts";
import { isDirectCapable, type BridgeEndpoint, type EgressTarget } from "./dispatcher.ts";
import { pickBest } from "./clash/select.ts";

/** 代理解析:把配置里的一个代理解析成出口路径。纯函数,不建连接,便于穷举测试。 */

export type ResolveFailure =
  | { kind: "not_found"; proxyId: string }
  | { kind: "disabled"; proxyId: string }
  | { kind: "clash_disabled"; proxyId: string }
  | { kind: "no_bridge"; proxyId: string }
  | { kind: "unusable"; proxyId: string; type: string };

export type ResolveResult = { ok: true; target: EgressTarget } | { ok: false; failure: ResolveFailure };

/** 选出该用哪个 Clash 内核。 */
export function pickBridge(clash: ClashConfig): BridgeEndpoint | null {
  if (!clash.enabled) return null;

  const enabled = clash.bridges.filter((b) => b.enabled);
  if (enabled.length === 0) return null;

  // manual:严格用选中的那个,被停用时不悄悄换一个。
  if (clash.selectionMode === "manual") {
    const chosen = enabled.find((b) => b.id === clash.activeBridgeId);
    if (!chosen) return null;
    return { bridgeId: chosen.id, host: chosen.localProxyHost, port: chosen.localProxyPort };
  }

  // auto:优先上次健康的那个,否则按 priority 取最优(数值小者优先)。
  const remembered = enabled.find((b) => b.id === clash.activeBridgeId);
  const best = remembered ?? pickBest(enabled);

  return { bridgeId: best.id, host: best.localProxyHost, port: best.localProxyPort };
}

/** 解析单个代理。直连优先:少一跳,且不受 selector 全局锁影响。 */
export function resolveProxy(config: Config, proxyId: string | null): ResolveResult {
  // 显式的「不走代理」。
  if (proxyId === null) return { ok: true, target: { mode: "none" } };

  const proxy = config.proxies.find((p) => p.id === proxyId);
  if (!proxy) {
    // 必须报错而不是退回本机直连:静默直连会破坏出口隔离。schema 已在加载期拦住,此处是运行期兜底。
    return { ok: false, failure: { kind: "not_found", proxyId } };
  }

  if (!proxy.enabled) return { ok: false, failure: { kind: "disabled", proxyId } };

  if (proxy.direct && isDirectCapable(proxy.type)) {
    return { ok: true, target: { mode: "direct", proxy } };
  }

  if (proxy.bridgeable) {
    if (!config.clash.enabled) {
      return { ok: false, failure: { kind: "clash_disabled", proxyId } };
    }
    const bridge = pickBridge(config.clash);
    if (bridge === null) return { ok: false, failure: { kind: "no_bridge", proxyId } };
    // nodeName 必须随 target 下传,参与 dispatcher 缓存身份(见 dispatcher.ts)。
    return {
      ok: true,
      target: { mode: "bridge", proxy, bridge, nodeName: bridgeNodeName(proxy) },
    };
  }

  return { ok: false, failure: { kind: "unusable", proxyId, type: proxy.type } };
}

/** 供 UI 与 doctor 用的中文说明。 */
export function describeResolveFailure(failure: ResolveFailure): string {
  switch (failure.kind) {
    case "not_found":
      return `代理 ${failure.proxyId} 不存在`;
    case "disabled":
      return `代理 ${failure.proxyId} 已停用`;
    case "clash_disabled":
      return `代理 ${failure.proxyId} 只能经 Clash 桥接,但 Clash 未启用`;
    case "no_bridge":
      return `代理 ${failure.proxyId} 需要 Clash 桥接,但没有可用内核`;
    case "unusable":
      return `代理 ${failure.proxyId} 的协议 ${failure.type} 既不能直连也不能桥接`;
  }
}

/** 桥接时该切到的 selector 节点:`clashNodeName` 优先,订阅导入时可能与 `name` 不同。 */
export function bridgeNodeName(proxy: Proxy): string {
  return proxy.clashNodeName !== undefined && proxy.clashNodeName !== ""
    ? proxy.clashNodeName
    : proxy.name;
}

/** 桥接时该操作哪个分组 —— 取所属内核的配置。 */
export function bridgeSelectorGroup(clash: ClashConfig, bridgeId: string): string | null {
  const bridge = clash.bridges.find((b) => b.id === bridgeId);
  return bridge?.selectorGroup ?? null;
}
