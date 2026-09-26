/**
 * 多 Clash 内核的择优(纯函数);探活在下方 `probeBridges`。
 *
 * `pickBridge`(`pool.ts`)只按配置推导,不知道内核是否活着;这一层用实测探活结果择优。
 * 判据顺序:活着(答得出 `/version`)→ 能出口(selector 分组里有节点)→ `priority` 小者 → id 字典序。
 * 刻意不按 Controller 延迟排序:那是内核到节点的延迟,与选哪个本机内核无关。
 * 有粘滞:换内核会重建 dispatcher 并可能改变出口 IP(加密推理块按出口签发),只在当前内核不可用时才换。
 */

import type { ClashBridge, ClashConfig } from "../../../shared/schema.ts";

/** 一个内核的探活结果。 */
export type BridgeHealth = {
  readonly bridgeId: string;
  /** Controller 答得出 `/version`。 */
  readonly alive: boolean;
  /** 版本串，仅用于显示。 */
  readonly version: string | null;
  /** selector 分组里可用节点数。0 表示连得上但没东西可出口。 */
  readonly usableNodes: number;
  /** 失败原因（已脱敏）。`alive` 为 true 时是 null。 */
  readonly reason: string | null;
};

export type SelectionOutcome = {
  /** 该用哪个内核。null 表示一个都不能用。 */
  readonly bridgeId: string | null;
  /** 是否需要把 `activeBridgeId` 写回配置;只在真的换了时为 true,避免无谓地重写 config.json。 */
  readonly changed: boolean;
  /** 人类可读的理由，进日志与界面。 */
  readonly reason: string;
};

/**
 * 从探活结果里选一个内核。`manual` 模式不参与择优:死掉时只说明原因,不悄悄换一个。
 */
export function selectBridge(
  clash: ClashConfig,
  health: readonly BridgeHealth[],
): SelectionOutcome {
  if (!clash.enabled) {
    return { bridgeId: null, changed: false, reason: "Clash 桥接未启用" };
  }

  const byId = new Map(health.map((h) => [h.bridgeId, h] as const));
  const enabled = clash.bridges.filter((b) => b.enabled);

  if (enabled.length === 0) {
    return { bridgeId: null, changed: false, reason: "没有启用的 Clash 内核" };
  }

  if (clash.selectionMode === "manual") {
    const chosen = enabled.find((b) => b.id === clash.activeBridgeId);
    if (chosen === undefined) {
      return {
        bridgeId: null,
        changed: false,
        reason:
          clash.activeBridgeId === null
            ? "manual 模式但没有选中内核"
            : `manual 模式选中的内核 ${clash.activeBridgeId} 不在已启用列表里`,
      };
    }
    const h = byId.get(chosen.id);
    if (h?.alive !== true) {
      // 不换 —— 只如实报告。
      return {
        bridgeId: chosen.id,
        changed: false,
        reason: `manual 模式选中的内核 ${chosen.name} 探活失败（${h?.reason ?? "未探活"}）；manual 模式不自动切换`,
      };
    }
    return { bridgeId: chosen.id, changed: false, reason: `manual 模式：${chosen.name}` };
  }

  // auto

  const usable = enabled.filter((b) => {
    const h = byId.get(b.id);
    return h?.alive === true && h.usableNodes > 0;
  });

  if (usable.length === 0) {
    // 一个都不可用时保留 `activeBridgeId`:清成 null 会让临时故障抹掉用户的内核选择。
    const aliveButEmpty = enabled.filter((b) => byId.get(b.id)?.alive === true);
    const reason =
      aliveButEmpty.length > 0
        ? `${aliveButEmpty.length} 个内核连得上但 selector 分组里没有可用节点`
        : `${enabled.length} 个内核全部探活失败`;
    return { bridgeId: clash.activeBridgeId, changed: false, reason };
  }

  // 粘滞:当前那个仍然可用就继续用它。
  const current = usable.find((b) => b.id === clash.activeBridgeId);
  if (current !== undefined) {
    return { bridgeId: current.id, changed: false, reason: `保持当前内核：${current.name}` };
  }

  const best = pickBest(usable);
  // `changed` 恒为 true:当前内核不在 `usable` 里(否则上面已返回),`best` 不可能是它。
  return {
    bridgeId: best.id,
    changed: true,
    reason:
      clash.activeBridgeId === null
        ? `自动选择：${best.name}`
        : `当前内核不可用，自动切换到：${best.name}`,
  };
}

/** `priority` 小者优先,同级按 id 字典序(刻意不按延迟)。转发路径的 `pickBridge` 共用。 */
export function pickBest(candidates: readonly ClashBridge[]): ClashBridge {
  return [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]!;
}

/**
 * 批测期间锁定单内核(不变量 #5 的延伸):批测中途换内核,后半批量到的是另一个内核的出口,
 * 按 IP 分组的隔离报告就成了噪声。只是建议,由调用方遵守;不在 `pickBridge` 里强制,以免冻住转发路径。
 */
export function lockedBridgeFor(
  clash: ClashConfig,
  health: readonly BridgeHealth[],
): { bridgeId: string | null; reason: string } {
  const outcome = selectBridge(clash, health);
  return {
    bridgeId: outcome.bridgeId,
    reason:
      outcome.bridgeId === null
        ? `批测无法进行：${outcome.reason}`
        : `批测锁定内核 ${outcome.bridgeId}（${outcome.reason}）`,
  };
}


/** 探活需要的 Controller 能力。 */
export type BridgeProbe = {
  readonly bridgeId: string;
  version(): Promise<{ version: string; isMeta: boolean }>;
  selectors(): Promise<Array<{ name: string; now: string; options: string[] }>>;
};

/**
 * 逐个探活,并发执行:只读 `/version` 与 `/proxies`,不改状态。
 * 连得上但 `selectorGroup` 里没节点算不可用(分组名写错时每个桥接代理都会失败);
 * 只数该分组,因为转发只走它(`bridgeSelectorGroup`)。
 */
export async function probeBridges(
  bridges: readonly ClashBridge[],
  probeOf: (bridge: ClashBridge) => BridgeProbe,
  deps: { readonly redact?: (err: unknown) => string } = {},
): Promise<BridgeHealth[]> {
  const redact = deps.redact ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));

  return await Promise.all(
    bridges.map(async (bridge): Promise<BridgeHealth> => {
      const probe = probeOf(bridge);
      let version: string;
      try {
        version = (await probe.version()).version;
      } catch (err) {
        return {
          bridgeId: bridge.id,
          alive: false,
          version: null,
          usableNodes: 0,
          reason: redact(err),
        };
      }

      try {
        const groups = await probe.selectors();
        const group = groups.find((g) => g.name === bridge.selectorGroup);
        if (group === undefined) {
          return {
            bridgeId: bridge.id,
            // 连得上要如实说;不可用由 usableNodes 判定。
            alive: true,
            version,
            usableNodes: 0,
            reason: `内核里没有名为 ${bridge.selectorGroup} 的 selector 分组`,
          };
        }
        return {
          bridgeId: bridge.id,
          alive: true,
          version,
          usableNodes: group.options.length,
          reason: group.options.length === 0 ? `分组 ${bridge.selectorGroup} 里没有节点` : null,
        };
      } catch (err) {
        // `/version` 过了而 `/proxies` 没过(如配置重载期间):仍报不可用,「能出口」才是判据。
        return {
          bridgeId: bridge.id,
          alive: false,
          version,
          usableNodes: 0,
          reason: `读取节点列表失败：${redact(err)}`,
        };
      }
    }),
  );
}
