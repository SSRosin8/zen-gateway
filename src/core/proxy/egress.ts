import type { Config, Proxy } from "../../shared/schema.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { ClashController } from "./clash/controller.ts";
import { credentialFingerprint } from "./credentialFingerprint.ts";
import { DispatcherError, DispatcherPool, type TimeoutConfig } from "./dispatcher.ts";
import { bridgeSelectorGroup, describeResolveFailure, resolveProxy } from "./pool.ts";
import { probeEgress, type IpEchoService, type ProbeOutcome, type ProbeRequest } from "./probe.ts";
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

/**
 * 探测结果的持久化接收端。
 *
 * 与 `AffinitySink` 同样的窄接口理由：`core/proxy/` 不该认识 SQLite
 * （`store/` 才是持久化层），而窄接口让测试能塞一个记录调用的假实现。
 *
 * **不得抛异常**：探测本身已经成功了，记不下来不该让它变成失败。
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
  /**
   * 探测结果落盘。
   *
   * 不传则不记 —— 大多数测试测的是探测行为本身，不该为此各建一个库。
   *
   * 生产环境要传（写入 `StatsStore.recordProbe()`）：若 `probeAll` 的结果只存在于
   * 返回值里，「这个代理上周是不是换过出口 IP」就无法回答，而 `egressIp` 正是出口隔离判定的唯一依据。
   */
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
  /** 只保留仍有在途流的关闭任务；空闲池关闭后立即移除。 */
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
     * apiBase/secret 变了要重建,否则会继续连旧地址或用旧凭证 ——
     * Controller 在构造时就把 secret 抓走存进 `#secret`,所以复用一个旧实例
     * 意味着改配置**完全无效**,症状是「密码明明改对了还是 401」。
     *
     * secret 用 `credentialFingerprint` 而**不是** `.length`:等长的两个
     * secret 长度指纹相同 → 键不变 → 旧实例被复用。这恰好命中最常见的
     * 修配置动作(把一个打错的密码改成另一个同长度的正确密码),而它
     * 一声不响。这条规则与 dispatcher 的代理口令共用同一个实现。
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

  /**
   * 探测一个代理的公网出口。
   *
   * 桥接模式下,「切 selector + 建连接」由 probeEgress 在锁内完成 ——
   * selector 的选中节点是全局状态,并发切换会让两条链路互相换掉对方的出口。
   */
  async probeProxy(config: Config, proxyId: string | null): Promise<ProbeProxyResult> {
    this.#assertOpen();
    const id = proxyId ?? DIRECT_EGRESS_ID;
    const result = await this.#probeProxyInner(config, proxyId, id);
    /*
     * 落盘放在这里而不是 `probeAll` 里：`probeProxy` 是**唯一**产出探测结果的
     * 地方（`probeAll` 只是并发调它），记在汇合点才不会漏掉单个探测的调用方。
     * 这与 catalog 那条「记账放汇合点，不在四条 return null 上各写一遍」同构。
     */
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
      // probeEgress 在锁内、select 完成后才读它。排队期间换配置不能让
      // 探测持有一个已经关闭的 dispatcher；回退到另一个回显服务也同理。
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
      // target.nodeName 与 dispatcher 身份同源，不能在两处各自推导。
      nodeName: target.nodeName,
    };
    return { proxyId: id, outcome: await probeEgress(common) };
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

  /**
   * 供转发链路复用**同一套**出口机构。
   *
   * 转发与探测必须共用一个 `DispatcherPool` 与一套 selector 锁,否则:
   *
   * - **锁分裂**:两个 registry 各自串行化,但 Clash selector 的 `now` 是
   *   **进程外的全局状态**。探测在切到节点 A 的同时,转发可能正切到 B ——
   *   于是探测量到的出口 IP 不是转发实际用的那个,而 `egressIp` 正是
   *   出口隔离报告的分组键。隔离结论会建立在错误数据上。
   * - **连接池分裂**:同一节点会有两套 keep-alive 连接,白费握手。
   *
   * 这是不变量 #7 的自然延伸:那一条要求缓存键含节点名,
   * 这一条要求**只有一个**缓存。
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
      // 每次尝试取当前池；请求的配置快照与 selector 锁不变，后续重试可采用
      // 新超时。这样旧池能优雅关闭，不会因保留整条重试链而无限积累。
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
    // close 不接受新请求，但允许已开始的响应流读完；不等待它完成，保存配置
    // 才不会被长 SSE 阻塞。关闭任务完成就移除，停机时只需等待剩余任务。
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
   * 立即断开当前池的连接并拒绝后续请求。停机排空超时后用它代替 `close()`。
   *
   * 热更新换下的旧池已在优雅关闭,undici 不再允许从外部切断它们
   * (见 `DispatcherPool.destroy`);它们的在途流随客户端连接被服务端断开,
   * 或随进程退出结束。
   */
  destroy(): void {
    this.#closed = true;
    this.#controllers.clear();
    this.#controllerKeys.clear();
    this.#pool.destroy();
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

/**
 * 探测结果里的**合成 id**：本机直连出口。
 *
 * 定义在 `shared/schema.ts` —— `IdSchema` 要拒绝它（否则一个同名代理会与
 * 直连共用身份，出口隔离失效），而那边不能 import 本文件。这里只 re-export，
 * 让既有调用点不必改 import 路径。
 */
export { DIRECT_EGRESS_ID };

/**
 * 把一批探测结果并回配置 —— 代理与**本机直连**一起。
 *
 * 抽成一个函数是因为它有**两个**调用方（`POST /api/probe` 与批量探测执行器），
 * 而"直连那一条要认合成 id"这个细节在两处各写一遍必然漏（纪律 #4）——
 * 两处都只处理 `config.proxies` 的话，直连的测量会被静默丢弃。
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
