import { createHash } from "node:crypto";
import type { Config } from "../../../shared/schema.ts";
import { ConfigSchema } from "../../../shared/schema.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import { isLoopbackAddress } from "../../../server/middleware/loopbackOnly.ts";
import { ClashController, ControllerError, type ProxyNode, type SelectorGroup } from "./controller.ts";

/**
 * 发现本机 Clash Controller 并把出口并进配置。`scripts/setup.mjs` 与管理面
 * `/api/clash/*` 共用这一份（纪律 #4）。
 *
 * 安全边界：只探 127.0.0.1 的固定端口白名单，绝不扫 LAN 或端口段；显式地址也必须是本机
 * http 回环，否则 secret 会被发往远端。
 *
 * 混合端口必须从 Controller 的 `/configs` 读 `mixed-port`：它随内核配置变化，
 * 硬编码会让桥接静默连到没人监听的端口，而控制面仍是通的。
 */

/** 候选 Controller 端口 —— 固定白名单，仅 127.0.0.1。刻意短，探不到让用户手填。 */
export const CANDIDATE_PORTS = [9090, 9097, 9091, 9093, 6170] as const;

/** 每个候选的探测超时（本机通信）。 */
const PROBE_TIMEOUT_MS = 1_500;

/** 显式指定的 Controller 地址是否为本机 http 回环（不带凭证、query 与 fragment）。 */
export function isLocalControllerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (host === "localhost" || isLoopbackAddress(host))
    );
  } catch {
    return false;
  }
}

export type ProbeOutcome =
  | { kind: "ok"; apiBase: string; secret: string; version: string; isMeta: boolean }
  | { kind: "auth"; apiBase: string }
  | { kind: "absent"; apiBase: string; why: string };

/**
 * 探一个候选地址。`auth` 不能合进 `absent`，否则配了 secret 的 Clash 会被报成「没找到」。
 */
export async function probeController(
  apiBase: string,
  secret: string,
): Promise<ProbeOutcome> {
  const controller = new ClashController({ id: "setup-probe", apiBase, apiSecret: secret }, { timeoutMs: PROBE_TIMEOUT_MS });
  try {
    const { version, isMeta } = await controller.version();
    return { kind: "ok", apiBase, secret, version, isMeta };
  } catch (err) {
    if (err instanceof ControllerError && err.kind === "auth") return { kind: "auth", apiBase };
    return { kind: "absent", apiBase, why: safeErrorMessage(err) };
  }
}

export type DiscoverOptions = {
  /** 显式地址：只探这一个，且必须是本机回环。 */
  readonly explicitApi?: string;
  /** 用户给的 secret，最先尝试。 */
  readonly secret?: string;
  /** 配置里已有的 secret —— 那是我们自己存的，不是猜测。 */
  readonly knownSecrets?: readonly string[];
};

export class NonLocalControllerError extends Error {
  override readonly name = "NonLocalControllerError";
  constructor() {
    super("Controller 地址必须是本机 http 回环地址，不会向远程地址发送 secret");
  }
}

/** 找出本机的 Controller。每个候选先用给定 secret（或免 secret）试，要鉴权时再逐个试已知 secret。 */
export async function discoverControllers(options: DiscoverOptions = {}): Promise<{
  results: ProbeOutcome[];
  tried: string[];
}> {
  if (options.explicitApi !== undefined && !isLocalControllerUrl(options.explicitApi)) {
    throw new NonLocalControllerError();
  }
  const candidates =
    options.explicitApi !== undefined
      ? [options.explicitApi]
      : CANDIDATE_PORTS.map((port) => `http://127.0.0.1:${port}`);
  const extra = [...new Set(options.knownSecrets ?? [])].filter((s) => s !== "" && s !== options.secret);

  const results: ProbeOutcome[] = [];
  for (const apiBase of candidates) {
    let result = await probeController(apiBase, options.secret ?? "");
    if (result.kind === "auth") {
      for (const secret of extra) {
        const retry = await probeController(apiBase, secret);
        if (retry.kind === "ok") {
          result = retry;
          break;
        }
      }
    }
    results.push(result);
  }
  return { results, tried: candidates };
}

export type ControllerInfo = {
  mixedPort: number | null;
  mode: string;
  selectors: SelectorGroup[];
  nodes: ProxyNode[];
  routed: { targets: ReadonlyMap<string, number>; fallback: string | null } | null;
};

/** 读取配置内核所需的全部信息，解析复用 `ClashController`，与 doctor 和转发路径同一份实现。 */
export async function readController(
  ctrl: { apiBase: string; secret: string },
): Promise<ControllerInfo> {
  const controller = new ClashController({ id: "setup", apiBase: ctrl.apiBase, apiSecret: ctrl.secret });

  /*
   * 混合端口读不到时为 null，由调用方拒绝配置；`socks-port` / `port` 不能替代：桥接 dispatcher
   * 使用 HTTP CONNECT。选路模式读不到时按 `rule`（内核默认，也是保守的一侧）。
   */
  const runtime = await controller.runtimeConfig().catch(() => ({ mode: null, mixedPort: null }));
  const [selectors, nodes] = await Promise.all([controller.selectors(), controller.nodes()]);
  // 旧内核可能没有 `/rules`，拿不到给 null。
  const routed = await controller.routedGroups().catch(() => null);

  return { mixedPort: runtime.mixedPort, mode: runtime.mode ?? "rule", selectors, nodes, routed };
}

/**
 * 挑一个 selector 分组。rule 模式下 `GLOBAL` 不参与选路，切它不改变实际出口：所有 Worker
 * 共用同一个公网 IP，且不报任何错。判据是 `/rules` 实际导向哪里；拿不到时按名字把 `GLOBAL`
 * 排到最后。`global` 模式下相反。
 */
export function pickSelector(
  selectors: readonly SelectorGroup[],
  nodes: readonly ProxyNode[],
  mode: string,
  routed: ControllerInfo["routed"],
): { selector: SelectorGroup; usable: number } | null {
  const nodeNames = new Set(nodes.map((n) => n.name));
  const ruleMode = mode !== "global";

  // 小者优先：0 = MATCH 兜底目标，1 = 出现在某条规则里，2 = 规则里没出现。
  const rank = (name: string) => {
    if (!ruleMode) return name === "GLOBAL" ? 0 : 1;
    if (routed === null) return name === "GLOBAL" ? 2 : 1;
    if (routed.fallback === name) return 0;
    return routed.targets.has(name) ? 1 : 2;
  };

  const scored = selectors
    .map((s) => ({ selector: s, usable: s.options.filter((o) => nodeNames.has(o)).length, rank: rank(s.name) }))
    .filter((x) => x.usable > 0)
    .sort((a, b) => a.rank - b.rank || b.usable - a.usable || a.selector.name.localeCompare(b.selector.name));
  const best = scored[0];
  return best === undefined ? null : { selector: best.selector, usable: best.usable };
}

/**
 * 代理 id，从节点名稳定推导：重跑时同一节点落到同一个 id，否则 Worker 仍绑着陈旧条目。
 * 节点名含空格、emoji 等 `IdSchema` 不允许的字符，故取哈希。
 */
export function proxyIdFor(nodeName: string): string {
  return `controller_${createHash("sha256").update(nodeName).digest("hex").slice(0, 24)}`;
}

/** 内核 id 从地址推导，重跑落到同一个 id。 */
export function bridgeIdFor(apiBase: string): string {
  const url = new URL(apiBase);
  // IPv6 字面量带方括号，`IdSchema` 不允许。
  return `bridge-${url.hostname.replace(/^\[|\]$/g, "")}-${url.port || "80"}`;
}

export type ControllerPlan = {
  apiBase: string;
  secret: string;
  isMeta: boolean;
  mode: string;
  mixedPort: number;
  selector: SelectorGroup;
  usable: number;
  nodes: ProxyNode[];
  otherSelectors: string[];
  /** 可配置但不理想的情况（只剩 GLOBAL 等），已是人可读文案。 */
  warnings: string[];
};

export type PlanOutcome = { ok: true; plan: ControllerPlan } | { ok: false; reason: string; detail?: string };

/** 读取一个已连通的 Controller 并决定怎么配。拒绝的情况给出原因而不猜默认值。 */
export async function planController(
  ctrl: { apiBase: string; secret: string; isMeta: boolean },
): Promise<PlanOutcome> {
  let info: ControllerInfo;
  try {
    info = await readController(ctrl);
  } catch (err) {
    return { ok: false, reason: safeErrorMessage(err) };
  }

  if (info.mixedPort === null) {
    return {
      ok: false,
      reason: "无法从 /configs 读出可用的代理端口",
      detail: "未读到有效的 mixed-port —— 桥接需要 HTTP 混合端口；socks-port / port 不能替代，请在 Clash 中开启 mixed-port。",
    };
  }

  const picked = pickSelector(info.selectors, info.nodes, info.mode, info.routed);
  if (picked === null) {
    return {
      ok: false,
      reason: "没有找到含可出口节点的 Selector 分组",
      detail: `分组 ${info.selectors.length} 个,节点 ${info.nodes.length} 个,但两者无交集。`,
    };
  }

  const warnings: string[] = [];
  if (info.mode !== "global" && picked.selector.name === "GLOBAL") {
    warnings.push(`只找到 GLOBAL 分组,而内核是 ${info.mode} 模式 —— 切换它可能不生效`);
  }

  return {
    ok: true,
    plan: {
      apiBase: ctrl.apiBase,
      secret: ctrl.secret,
      isMeta: ctrl.isMeta,
      mode: info.mode,
      mixedPort: info.mixedPort,
      selector: picked.selector,
      usable: picked.usable,
      nodes: info.nodes,
      otherSelectors: info.selectors.filter((s) => s.name !== picked.selector.name).map((s) => s.name),
      warnings,
    },
  };
}

export type ImportSummary = {
  bridgesAdded: number;
  bridgesUpdated: number;
  proxiesAdded: number;
  proxiesUpdated: number;
  /** 合并本身产生的提示（如内核停用未设为当前）；各 plan 的 `warnings` 由调用方另行展示。 */
  warnings: string[];
};

/**
 * 把发现结果并进配置（纯函数，不写盘）。保留全部 Worker、Relay Token 与用户改过的
 * name/priority/enabled；只更新探测得来的事实（端口、secret、分组）。不创建 Worker。
 */
export function mergeControllerImport(
  config: Config,
  plans: readonly ControllerPlan[],
): { ok: true; next: Config; summary: ImportSummary } | { ok: false; reason: string } {
  const next = structuredClone(config) as Config;
  next.clash.enabled = true;
  const summary: ImportSummary = { bridgesAdded: 0, bridgesUpdated: 0, proxiesAdded: 0, proxiesUpdated: 0, warnings: [] };

  for (const plan of plans) {
    const bridgeId = bridgeIdFor(plan.apiBase);
    const existing = next.clash.bridges.find((b) => b.id === bridgeId);

    if (existing === undefined) {
      next.clash.bridges.push({
        id: bridgeId,
        name: `${plan.isMeta ? "mihomo" : "clash"} ${new URL(plan.apiBase).port}`,
        enabled: true,
        priority: 100,
        apiBase: plan.apiBase,
        apiSecret: plan.secret,
        localProxyHost: "127.0.0.1",
        localProxyPort: plan.mixedPort,
        selectorGroup: plan.selector.name,
      });
      summary.bridgesAdded += 1;
    } else {
      // 重新启用被停用的内核等于撤销用户的决定，所以 enabled 不动。
      existing.apiBase = plan.apiBase;
      existing.apiSecret = plan.secret;
      existing.localProxyPort = plan.mixedPort;
      existing.selectorGroup = plan.selector.name;
      summary.bridgesUpdated += 1;
    }

    // 只导入这个分组里的节点 —— 分组外的节点切不过去。
    const inGroup = new Set(plan.selector.options);
    for (const node of plan.nodes) {
      if (!inGroup.has(node.name)) continue;
      const id = proxyIdFor(node.name);
      const existingProxy = next.proxies.find((p) => p.id === id);
      if (existingProxy === undefined) {
        next.proxies.push({
          id,
          name: node.name.slice(0, 200),
          type: node.type.toLowerCase().slice(0, 32) || "unknown",
          // 指向本机 Clash 混合端口而非节点真实地址：流量交给 Clash 按 selector 转出。
          host: "127.0.0.1",
          port: plan.mixedPort,
          enabled: true,
          source: "controller",
          controllerGroup: plan.selector.name,
          bridgeId,
          clashNodeName: node.name,
          // anytls/vless/hysteria2 等 undici 与 socks 都接不了，只能经桥接。
          direct: false,
          bridgeable: true,
          egressIp: null,
        });
        summary.proxiesAdded += 1;
      } else {
        existingProxy.port = plan.mixedPort;
        existingProxy.bridgeId = bridgeId;
        existingProxy.clashNodeName = node.name;
        existingProxy.controllerGroup = plan.selector.name;
        summary.proxiesUpdated += 1;
      }
    }

    /*
     * `activeBridgeId` 只在为空时设，`selectionMode` 不动。绝不指向停用的内核：manual 模式下
     * `pickBridge` 只在已启用内核里找，指过去会让每个桥接代理都失败。
     */
    if (next.clash.activeBridgeId === null) {
      const candidate = next.clash.bridges.find((b) => b.id === bridgeId);
      if (candidate?.enabled === true) next.clash.activeBridgeId = bridgeId;
      else summary.warnings.push(`内核 ${bridgeId} 处于停用状态,未设为当前内核 —— 启用它之后再导入一次。`);
    }
  }

  // 写盘前过 schema：合并结果非法时在碰文件之前就知道。
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.map(String).join(".") || "(根)"}: ${i.message}`)
        .join("; "),
    };
  }
  return { ok: true, next: parsed.data, summary };
}
