import type { ClashConfig, Config, Proxy } from "../../shared/schema.ts";
import { isDirectCapable, type BridgeEndpoint, type EgressTarget } from "./dispatcher.ts";

/**
 * 代理解析:把配置里的一个代理解析成一条可用的出口路径。
 *
 * 纯函数,不建连接、不发请求 —— 「这个代理该怎么走」与「怎么真的走」
 * 分开,前者才能被穷举测试。
 */

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

  // manual:严格用选中的那个。选中的被停用时不悄悄换一个 ——
  // 那会让「我明明指定了内核」变成一个无从察觉的偏差。
  if (clash.selectionMode === "manual") {
    const chosen = enabled.find((b) => b.id === clash.activeBridgeId);
    if (!chosen) return null;
    return { bridgeId: chosen.id, host: chosen.localProxyHost, port: chosen.localProxyPort };
  }

  // auto:优先上次健康的那个,否则按 priority 取最优(数值小者优先)。
  const remembered = enabled.find((b) => b.id === clash.activeBridgeId);
  const best =
    remembered ??
    [...enabled].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]!;

  return { bridgeId: best.id, host: best.localProxyHost, port: best.localProxyPort };
}

/**
 * 解析单个代理。
 *
 * 直连优先:协议本身能出口时不绕 Clash —— 少一跳,且不受 selector 全局状态影响
 * (桥接必须持锁串行切换 selector,直连没有这个瓶颈)。
 */
export function resolveProxy(config: Config, proxyId: string | null): ResolveResult {
  // 显式的「不走代理」。
  if (proxyId === null) return { ok: true, target: { mode: "none" } };

  const proxy = config.proxies.find((p) => p.id === proxyId);
  if (!proxy) {
    /*
     * 引用不存在的代理。
     *
     * 这里必须是错误,不能退回本机直连:静默直连意味着这个 Worker
     * 与其他 Worker 共用同一个公网 IP,而出口隔离正是本项目存在的理由。
     * (schema 的引用完整性已在加载期拦住这种配置,此处是运行期兜底。)
     */
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
    /*
     * nodeName 必须随 target 一起传下去：dispatcher 的缓存身份要包含它，
     * 否则同一内核上的所有桥接代理共用一个连接池，而 Clash 在建连时就
     * 把连接绑定到当时选中的节点 —— 复用旧连接会让出口停留在旧节点，
     * 刚执行的 select() 形同虚设（见 dispatcher.ts 的说明）。
     */
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

/**
 * 桥接时该切到哪个 selector 节点。
 *
 * `clashNodeName` 优先于 `name`:从订阅导入时两者可能不同,
 * 而 selector 只认 Clash 自己的节点名。
 */
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
