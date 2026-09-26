import type { Config, Proxy } from "../../shared/schema.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { ClashController } from "./clash/controller.ts";
import { credentialFingerprint } from "./credentialFingerprint.ts";
import { DispatcherError, DispatcherPool, type TimeoutConfig } from "./dispatcher.ts";
import { bridgeSelectorGroup, describeResolveFailure, resolveProxy } from "./pool.ts";
import { probeEgress, type IpEchoService, type ProbeOutcome, type ProbeRequest } from "./probe.ts";
import { SelectorLockRegistry } from "./selectorLock.ts";

/**
 * 出口链路的编排层:resolveProxy → 取 dispatcher → (桥接则持锁切 selector) → 探测公网 IP。
 * 判断都在各自的纯函数模块里,这里只负责接线。
 */

/**
 * 探测结果的持久化接收端。窄接口让 `core/proxy/` 不认识 SQLite,测试也能塞假实现。
 * 不得抛异常:探测已成功,记不下来不该变成失败。
 */
export type ProbeSink = {
  recordProbe(row: {
    proxyId: string;
    at: number;
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    failureKind: string | null;
  }): void;
};

export type EgressServiceOptions = {
  timeouts: TimeoutConfig;
  /** 探测结果落盘;不传则不记。生产环境写入 `StatsStore.recordProbe()`,保留出口 IP 历史。 */
  probes?: ProbeSink;
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
  /** 只保留仍有在途流的关闭任务;空闲池关闭后立即移除。 */
  #closingPools = new Set<Promise<void>>();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #locks = new SelectorLockRegistry();
  #controllers = new Map<string, ClashController>();
  /** 与 #controllers 平行:记下建立时的 apiBase/secret 指纹,用于判断是否需重建。 */
  #controllerKeys = new Map<string, string>();
  #opts: EgressServiceOptions;

  constructor(opts: EgressServiceOptions) {
    this.#opts = opts;
    this.#pool = new DispatcherPool(opts.timeouts);
  }

  #assertOpen(): void {
    if (this.#closed) throw new DispatcherError("出口服务已关闭", null);
  }

  /** 按内核缓存 Controller 客户端。 */
  controllerFor(config: Config, bridgeId: string): ClashController | null {
    this.#assertOpen();
    const bridge = config.clash.bridges.find((b) => b.id === bridgeId);
    if (!bridge) return null;

    const cached = this.#controllers.get(bridgeId);
    /*
     * apiBase/secret 变了要重建:Controller 构造时就抓走 secret,复用旧实例会让改配置无效。
     * secret 用 `credentialFingerprint` 而不是长度,否则改成等长的正确密码仍复用旧实例。
     */
    const key = `${bridge.apiBase}|${credentialFingerprint(bridge.apiSecret)}`;
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

  /** 探测一个代理的公网出口;桥接时由 probeEgress 在锁内切 selector。 */
  async probeProxy(config: Config, proxyId: string | null): Promise<ProbeProxyResult> {
    this.#assertOpen();
    const id = proxyId ?? DIRECT_EGRESS_ID;
    const result = await this.#probeProxyInner(config, proxyId, id);
    // 落盘放在唯一产出探测结果的汇合点,不会漏掉单个探测的调用方。
    const o = result.outcome;
    this.#opts.probes?.recordProbe({
      proxyId: id,
      at: Date.now(),
      ok: o.ok,
      egressIp: o.ok ? o.egressIp : null,
      latencyMs: o.ok ? o.latencyMs : null,
      failureKind: o.ok ? null : o.failureKind,
    });
    return result;
  }

  async #probeProxyInner(
    config: Config,
    proxyId: string | null,
    id: string,
  ): Promise<ProbeProxyResult> {

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

    try {
      this.#pool.get(target);
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

    const service = this;
    const common: ProbeRequest = {
      // probeEgress 在锁内、select 完成后才读它:排队期间换配置不能让探测持有已关闭的 dispatcher。
      get dispatcher() {
        service.#assertOpen();
        return service.#pool.get(target);
      },
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

    common.bridge = {
      lock: this.#locks.forBridge(target.bridge.bridgeId),
      controller,
      selectorGroup: group,
      // target.nodeName 与 dispatcher 身份同源,不能在两处各自推导。
      nodeName: target.nodeName,
    };
    return { proxyId: id, outcome: await probeEgress(common) };
  }

  /**
   * 批量探测。桥接代理由 selector 锁天然串行化,直连代理真正并发;
   * `concurrency` 限制总在途数,避免回显服务限流。
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

  /**
   * 供转发链路复用同一套出口机构。转发与探测必须共用一个 `DispatcherPool` 与一套 selector 锁:
   * selector `now` 是进程外全局状态,锁分裂会让探测量到的 IP 不是转发实际用的那个。
   * 这是不变量 #7 的延伸:缓存键含节点名,且只有一个缓存。
   */
  upstreamDeps(config: Config): {
    config: Config;
    dispatchers: DispatcherPool;
    locks: SelectorLockRegistry;
    controllerFor: (bridgeId: string) => ClashController | null;
  } {
    this.#assertOpen();
    const service = this;
    return {
      config,
      // 每次尝试取当前池:旧池能优雅关闭,不会因保留整条重试链而无限积累。
      get dispatchers() {
        service.#assertOpen();
        return service.#pool;
      },
      locks: this.#locks,
      controllerFor: (bridgeId) => this.controllerFor(config, bridgeId),
    };
  }

  /**
   * 换一个新池,让缓存失效;可选同步新超时。旧连接在后台退出,不阻塞配置保存。
   * 同步返回:它只发起旧池的关闭,不等待。
   */
  reset(timeouts: TimeoutConfig = this.#opts.timeouts): void {
    this.#replacePool(timeouts);
  }

  #replacePool(timeouts: TimeoutConfig): void {
    this.#assertOpen();
    this.#opts = { ...this.#opts, timeouts };
    const old = this.#pool;
    this.#pool = new DispatcherPool(timeouts);
    this.#controllers.clear();
    this.#controllerKeys.clear();
    // 不等待旧池关闭,保存配置才不会被长 SSE 阻塞;关闭完成即移除。
    const closing = old.close().catch(() => {}).finally(() => this.#closingPools.delete(closing));
    this.#closingPools.add(closing);
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#controllers.clear();
    this.#controllerKeys.clear();
    this.#closePromise = Promise.allSettled([
      this.#pool.close(),
      ...this.#closingPools,
    ]).then(() => undefined);
    return this.#closePromise;
  }

  /**
   * 立即断开当前池的连接并拒绝后续请求,停机排空超时后代替 `close()`。
   * 热更新换下的旧池已在优雅关闭,无法再从外部切断(见 `DispatcherPool.destroy`)。
   */
  destroy(): void {
    this.#closed = true;
    this.#controllers.clear();
    this.#controllerKeys.clear();
    this.#pool.destroy();
  }
}

/**
 * 从探测结果算出代理的新状态。失败不清空已有 IP:一次抖动不该让隔离视图退回「未知」。
 */
export function applyProbeResult(proxy: Proxy, outcome: ProbeOutcome): Proxy {
  if (!outcome.ok) return proxy;
  return { ...proxy, egressIp: outcome.egressIp };
}

/**
 * 把一批探测结果并回配置,代理与本机直连一起。两个调用方(`POST /api/probe` 与批量探测执行器)
 * 共用,避免直连的合成 id 在某处漏掉(纪律 #4)。
 */
export function applyProbeResults(
  config: Config,
  outcomes: ReadonlyMap<string, ProbeOutcome>,
): { config: Config; changed: boolean } {
  let changed = false;

  const proxies = config.proxies.map((proxy) => {
    const outcome = outcomes.get(proxy.id);
    if (outcome === undefined) return proxy;
    const updated = applyProbeResult(proxy, outcome);
    if (updated.egressIp !== proxy.egressIp) changed = true;
    return updated;
  });

  let gateway = config.gateway;
  const direct = outcomes.get(DIRECT_EGRESS_ID);
  if (direct !== undefined && direct.ok && direct.egressIp !== gateway.directEgressIp) {
    gateway = { ...gateway, directEgressIp: direct.egressIp };
    changed = true;
  }

  return { config: { ...config, proxies, gateway }, changed };
}
