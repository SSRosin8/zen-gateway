/**
 * 多 Clash 内核的择优 —— **纯函数**。
 *
 * 探活在 `probeBridges`（下面，要发请求）；这里只回答「手上这几份探活结果
 * 该选谁」。分开的理由与 `routing/` 那几块同源：判断能被穷举测试。
 *
 * ## 为什么需要这一层
 *
 * `pickBridge`（`pool.ts`）已经会**选**：manual 严格用选中的，auto 优先
 * 上次记住的、否则按 `priority`。但它是纯配置推导 —— **它从不知道内核是否
 * 活着**。`auto` 模式注释写的「优先上次健康的那个」里，"健康"这个词此前
 * 没有任何东西去测量：`activeBridgeId` 在 auto 模式下的语义是"最近一个健康
 * 内核"，而全项目只有 `setup.mjs` 在首次配置时写过它一次。
 *
 * 于是实际行为是：auto 模式下永远用同一个内核，它挂了也不会换 —— 而
 * "多内核候选 + 自动择优"正是这一阶段要交付的东西。
 *
 * ## 择优的判据顺序，以及为什么不按延迟
 *
 * 1. **活着**（Controller 答得出 `/version`）—— 死的内核直接出局；
 * 2. **能出口**（至少有一个可用节点在它的 selector 分组里）；
 * 3. `priority` 小者优先（用户的显式偏好）；
 * 4. id 字典序（稳定兜底，避免"两次跑出不同结果"）。
 *
 * **刻意不按 Controller 的延迟数排序**：那是内核到**节点**的延迟，与
 * "本机到内核" 无关，而后者才是这里要比的东西（内核都在本机，那个延迟
 * 恒为零点几毫秒）。按节点延迟排会让"哪个内核"这个决定被"它恰好测过的那个
 * 节点当时网络好不好"左右 —— 那是个随机数。
 *
 * ## 切换内核的代价：所以有粘滞
 *
 * 换内核意味着换本地代理端口，进而 dispatcher 全部重建（`nodeName` 与
 * 端口都参与缓存键）。在途请求不受影响（它们持着旧连接），但**会话亲和
 * 绑定的语义会变**：同一个 Worker 换内核后走的是另一条物理链路，出口 IP
 * 可能变，而上游的加密推理块是按出口签发的。
 *
 * 所以：**只在当前内核不可用时才换**。当前内核活着就一直用它，哪怕另一个
 * `priority` 更小 —— 那与 `pickBridge` 的 `remembered` 优先是同一个道理，
 * 只是这里的"活着"是实测的而不是记忆的。
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
  /**
   * 是否需要把 `activeBridgeId` 写回配置。
   *
   * 只在**真的换了**时为 true —— 每次探活都写盘会让 config.json 无谓地
   * 反复原子写（而它是唯一一份凭证存储，写它不是免费的）。
   */
  readonly changed: boolean;
  /** 人类可读的理由，进日志与界面。 */
  readonly reason: string;
};

/**
 * 从探活结果里选一个内核。
 *
 * `manual` 模式**完全不参与择优** —— 用户指定了就是指定了。这里只负责在
 * 它死掉时把原因说清楚，而不是悄悄换一个（那会让「我明明选了这个内核」
 * 变成一个无从察觉的偏差，与 `pickBridge` 的判断一致）。
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

  /* ---- auto ---- */

  const usable = enabled.filter((b) => {
    const h = byId.get(b.id);
    return h?.alive === true && h.usableNodes > 0;
  });

  if (usable.length === 0) {
    /*
     * 一个都不可用时**保留** `activeBridgeId` 不变。
     *
     * 清成 null 会让"Clash 整个挂了一分钟"变成"用户的内核选择被抹掉"，
     * 而恢复之后它不会自己回来 —— 那是用信息丢失去表达一个临时状态。
     */
    const aliveButEmpty = enabled.filter((b) => byId.get(b.id)?.alive === true);
    const reason =
      aliveButEmpty.length > 0
        ? `${aliveButEmpty.length} 个内核连得上但 selector 分组里没有可用节点`
        : `${enabled.length} 个内核全部探活失败`;
    return { bridgeId: clash.activeBridgeId, changed: false, reason };
  }

  // 粘滞：当前那个仍然可用就继续用它 —— 换内核的代价见文件头。
  const current = usable.find((b) => b.id === clash.activeBridgeId);
  if (current !== undefined) {
    return { bridgeId: current.id, changed: false, reason: `保持当前内核：${current.name}` };
  }

  const best = pickBest(usable);
  /*
   * 这里 `changed` 恒为 true，所以直接写 true 而不是比一次 id。
   *
   * 走到这一行意味着当前内核**不在** `usable` 里（可用的话上面那条粘滞
   * 已经返回了），而 `best` 取自 `usable` —— 两者不可能是同一个。
   * 第八轮之后的变异测试证实了这一点：把它改成恒 true 没有任何断言会红，
   * 而按四分类这属于「代码里有死信息」而不是「缺一条测试」。
   * 写 `best.id !== clash.activeBridgeId` 会让读者以为存在"选回了自己"的
   * 情形并去想它的含义，而那个情形不存在。
   */
  return {
    bridgeId: best.id,
    changed: true,
    reason:
      clash.activeBridgeId === null
        ? `自动选择：${best.name}`
        : `当前内核不可用，自动切换到：${best.name}`,
  };
}

/** `priority` 小者优先，同级按 id 字典序 —— 见文件头（刻意不按延迟）。 */
function pickBest(candidates: readonly ClashBridge[]): ClashBridge {
  return [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]!;
}

/**
 * 批测期间锁定单内核。
 *
 * 规划明确要求这一条。理由是不变量 #5 的延伸：桥接探测要**切 selector**，
 * 而 selector 是进程外的全局状态。一批探测跑到一半换了内核，后半批量到的
 * 是另一个内核的出口 —— 而隔离报告把两批结果混在一起按 IP 分组，
 * 于是"这两个 Worker 出口相同吗"这个问题的答案变成了噪声。
 *
 * 实现上是个**建议**而不是强制：返回"批测期间该用哪个"，由调用方遵守。
 * 做成强制（比如在 `pickBridge` 里加一个全局开关）会让转发路径也被冻住，
 * 而那没必要 —— 转发不切 selector（它用 `bridgeNodeName` 持锁走当前节点）。
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

/* ------------------------------------------------------------------ *
 * 探活（要发请求 —— 与上面的纯判断分开）
 * ------------------------------------------------------------------ */

/** 探活需要的 Controller 能力。只要这两个方法，不要整个 `ClashController`。 */
export type BridgeProbe = {
  readonly bridgeId: string;
  version(): Promise<{ version: string; isMeta: boolean }>;
  selectors(): Promise<Array<{ name: string; now: string; options: string[] }>>;
};

/**
 * 逐个探活。
 *
 * ## 并发而不是串行
 *
 * 与出口探测（那个必须串行，因为要切 selector）相反：探活只读
 * `/version` 与 `/proxies`，**不改任何状态**，所以并发是安全的。
 * 而内核数可能有好几个、每个都有超时 —— 串行会让"看一眼哪个内核活着"
 * 变成一个几秒的操作，而它会在每次批测前跑。
 *
 * ## 连得上但分组里没节点，算"不可用"而不是"活着"
 *
 * 那是本机真实踩过的形态（`selectorGroup` 写错名字、或分组被改过）：
 * Controller 答得好好的，而 `pickBridge` 选中它之后每个桥接代理都失败。
 * 所以 `usableNodes` 要参与判定，`selectBridge` 才能把它排除掉。
 *
 * ## 为什么用 `selectorGroup` 而不是全部节点数
 *
 * 转发只走那个分组（`bridgeSelectorGroup`）。别的分组里有一百个节点
 * 也与本网关无关 —— 按总数判定会选中一个"节点很多但我们用的那个分组是空的"
 * 内核。
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
            // 连得上 —— 这是真的，要如实说。不可用的判定交给 usableNodes。
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
        /*
         * `/version` 过了而 `/proxies` 没过 —— 内核在跑但状态不对
         * （实测过：某些内核在配置重载期间会短暂这样）。仍报 alive: false，
         * 因为"能出口"是这里唯一有意义的判据。
         */
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
