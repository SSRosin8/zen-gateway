import type { Config, Proxy } from "../../shared/schema.ts";
import { ClashController } from "./clash/controller.ts";
import { DispatcherPool, type TimeoutConfig } from "./dispatcher.ts";
import {
  bridgeNodeName,
  bridgeSelectorGroup,
  describeResolveFailure,
  resolveProxy,
} from "./pool.ts";
import { probeEgress, type IpEchoService, type ProbeOutcome } from "./probe.ts";
import { SelectorLockRegistry } from "./selectorLock.ts";

/**
 * 出口链路的编排层。
 *
 * 把「配置里的一个代理」变成「一次实测过的出口」:
 *   resolveProxy → 取 dispatcher → (桥接则持锁切 selector) → 探测公网 IP
 *
 * 这一层只做编排,所有判断都在各自的纯函数模块里 ——
 * 于是「该怎么走」可以被穷举测试,而这里只需验证「接得对」。
 */

export type EgressServiceOptions = {
  timeouts: TimeoutConfig;
  /** 注入以便测试;生产用默认列表。 */
  services?: IpEchoService[];
  probeTimeoutMs?: number;
  /** Controller 请求超时。 */
  controllerTimeoutMs?: number;
};

export type ProbeProxyResult = {
  proxyId: string;
  outcome: ProbeOutcome;
};

export class EgressService {
  #pool: DispatcherPool;
  #locks = new SelectorLockRegistry();
  #controllers = new Map<string, ClashController>();
  /** 与 #controllers 平行:记下建立时的 apiBase/secret 指纹,用于判断是否需重建。 */
  #controllerKeys = new Map<string, string>();
  #opts: EgressServiceOptions;

  constructor(opts: EgressServiceOptions) {
    this.#opts = opts;
    this.#pool = new DispatcherPool(opts.timeouts);
  }

  /** 按内核缓存 Controller 客户端。 */
  controllerFor(config: Config, bridgeId: string): ClashController | null {
    const bridge = config.clash.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;

    const cached = this.#controllers.get(bridgeId);
    // apiBase/secret 变了要重建,否则会继续连旧地址或用旧凭证。
    // 只用 secret 的长度参与指纹:这个键会进诊断输出。
    const key = `${bridge.apiBase}|${bridge.apiSecret.length}`;
    if (cached && this.#controllerKeys.get(bridgeId) === key) return cached;

    const controller = new ClashController(bridge, {
      ...(this.#opts.controllerTimeoutMs !== undefined
        ? { timeoutMs: this.#opts.controllerTimeoutMs }
        : {}),
    });
    this.#controllers.set(bridgeId, controller);
    this.#controllerKeys.set(bridgeId, key);
    return controller;
  }

  /**
   * 探测一个代理的公网出口。
   *
   * 桥接模式下,「切 selector + 建连接」由 probeEgress 在锁内完成 ——
   * selector 的选中节点是全局状态,并发切换会让两条链路互相换掉对方的出口。
   */
  async probeProxy(config: Config, proxyId: string | null): Promise<ProbeProxyResult> {
    const id = proxyId ?? "__direct__";

    const resolved = resolveProxy(config, proxyId);
    if (!resolved.ok) {
      return {
        proxyId: id,
        outcome: {
          ok: false,
          failureKind: "bad_request",
          reason: describeResolveFailure(resolved.failure),
        },
      };
    }

    const target = resolved.target;

    let dispatcher;
    try {
      dispatcher = this.#pool.get(target);
    } catch (err) {
      return {
        proxyId: id,
        outcome: {
          ok: false,
          failureKind: "bad_request",
          reason: err instanceof Error ? err.message : "无法建立出口",
        },
      };
    }

    const common = {
      dispatcher,
      ...(this.#opts.services !== undefined ? { services: this.#opts.services } : {}),
      ...(this.#opts.probeTimeoutMs !== undefined ? { timeoutMs: this.#opts.probeTimeoutMs } : {}),
    };

    if (target.mode !== "bridge") {
      return { proxyId: id, outcome: await probeEgress(common) };
    }

    const controller = this.controllerFor(config, target.bridge.bridgeId);
    if (controller === null) {
      return {
        proxyId: id,
        outcome: {
          ok: false,
          failureKind: "bad_request",
          reason: `Clash 内核 ${target.bridge.bridgeId} 不存在`,
        },
      };
    }

    const group = bridgeSelectorGroup(config.clash, target.bridge.bridgeId);
    if (group === null) {
      return {
        proxyId: id,
        outcome: { ok: false, failureKind: "bad_request", reason: "内核未配置 selector 分组" },
      };
    }

    return {
      proxyId: id,
      outcome: await probeEgress({
        ...common,
        bridge: {
          lock: this.#locks.forBridge(target.bridge.bridgeId),
          controller,
          selectorGroup: group,
          nodeName: bridgeNodeName(target.proxy),
        },
      }),
    };
  }

  /**
   * 批量探测。
   *
   * 桥接代理天然被 selector 锁串行化(共享同一个内核的全局状态),
   * 直连代理可以真正并发。这里不自己分组 —— 锁已经保证了正确性,
   * 再加一层调度只会让行为更难推理。`concurrency` 限制的是总的在途请求数,
   * 避免几十个节点同时打向 IP 回显服务而被限流。
   */
  async probeAll(
    config: Config,
    proxyIds: Array<string | null>,
    concurrency = 4,
  ): Promise<ProbeProxyResult[]> {
    const results: ProbeProxyResult[] = [];
    const queue = [...proxyIds];

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        results.push(await this.probeProxy(config, next));
      }
    });

    await Promise.all(workers);
    return results;
  }

  /** 配置变更后让缓存失效。 */
  async reset(): Promise<void> {
    this.#controllers.clear();
    this.#controllerKeys.clear();
    await this.#pool.reset();
  }

  async close(): Promise<void> {
    this.#controllers.clear();
    this.#controllerKeys.clear();
    await this.#pool.close();
  }
}

/**
 * 从探测结果算出代理的新状态。
 *
 * 纯函数:探测成功就记下实测 IP;失败**不清空**已有的 IP ——
 * 一次网络抖动不该让「这个代理的出口是什么」这条已知事实消失,
 * 否则出口隔离视图会在每次抖动时把已确认隔离的节点退回「未知」。
 */
export function applyProbeResult(proxy: Proxy, outcome: ProbeOutcome): Proxy {
  if (!outcome.ok) return proxy;
  return { ...proxy, egressIp: outcome.egressIp };
}
