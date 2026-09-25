// 必须用 undici 的 fetch,不是全局 fetch:`dispatcher` 是 undici 特有的选项,
// 全局 fetch 会静默忽略它 —— 于是所有请求都走本机默认出口,出口隔离整体失效
// 且毫无报错。Phase 2 的 probe.ts 同样从 undici 导入,两处保持一致。
// 类型也一并取自 undici:它的 RequestInit 才有 `dispatcher`,
// 用全局的 RequestInit 需要交叉类型硬凑,那会掩盖签名不匹配。
import {
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import type { Config } from "../../shared/schema.ts";
import { bridgeSelectorGroup, describeResolveFailure, resolveProxy } from "../proxy/pool.ts";
import type { DispatcherPool } from "../proxy/dispatcher.ts";
import type { SelectorLockRegistry } from "../proxy/selectorLock.ts";
import type { ClashController } from "../proxy/clash/controller.ts";

/**
 * 单次上游请求。
 *
 * 这一层只做「把一个请求经指定出口发出去,拿到响应头」,**不做重试、不读响应体**。
 * 这个边界是规划的不变量 #1:重试判定只能看 status + headers,响应体必须
 * 保持未消费,由上层决定是转发给客户端还是丢弃。
 *
 * ## 不变量 #5:selector 锁的范围
 *
 * 桥接出口下「切 selector + 建立连接」必须原子,但锁**必须在响应体开始流之前
 * 释放** —— 否则一条长 SSE 会把整个网关串行化。
 *
 * 临界区的正确边界恰好是 `fetch()` 的 resolve 时机:响应头到达时连接已建立
 * 并绑定到当时选中的节点,之后再切 selector 不影响这条连接。
 *
 * **因此下面 `lock.run()` 的回调必须返回 Response 本身,绝不能返回读体的
 * Promise。** `.then()` 会自动同化返回的 Promise,写成
 * `run(async () => (await fetch(...)).text())` 会把锁一直持到整个响应体读完。
 * 这个区别不体现在类型签名上,只能靠注释与测试守住。
 *
 * ## 不变量 #7:桥接 dispatcher 必须按节点缓存
 *
 * Clash 在**建连时**绑定出站节点,而 undici 会复用 keep-alive 连接 ——
 * 若 dispatcher 按 Worker 或 proxy id 缓存,池里的活连接会让刚做的 `select()`
 * 完全失效,流量从旧节点出去。`DispatcherPool` 已把 `nodeName` 纳入缓存键,
 * 而 `nodeName` 由 `resolveProxy` 单点提供 —— 这里**不自己算节点名**,
 * 否则迟早出现「锁切到 A 而 dispatcher 属于 B」。
 */

export type UpstreamRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** 原始请求体字节。原样透传 —— 绝不反序列化再序列化(那不是无损的)。 */
  readonly body: Uint8Array | null;
  /** 绑定的出口代理 id;null 表示本机直连出口。 */
  readonly proxyId: string | null;
  readonly signal?: AbortSignal;
};

export type UpstreamDeps = {
  readonly config: Config;
  readonly dispatchers: DispatcherPool;
  readonly locks: SelectorLockRegistry;
  /** 按内核 id 取 Controller;桥接模式必需。 */
  readonly controllerFor: (bridgeId: string) => ClashController | null;
  /** 注入以便测试。签名跟 undici 的 fetch,而不是全局 fetch。 */
  readonly fetchImpl?: typeof undiciFetch;
};

export class EgressSetupError extends Error {
  override readonly name = "EgressSetupError";
}

/**
 * 发出一次上游请求,返回**响应体未被消费**的 Response。
 *
 * 出口配置问题(代理不存在、只能桥接但 Clash 关着、内核缺 selector 分组)
 * 抛 `EgressSetupError` —— 那是配置错误,与上游的网络失败必须区分开:
 * 前者重试任何 Worker 都不会好,后者换个 Worker 可能就成功。
 */
export async function fetchUpstream(
  req: UpstreamRequest,
  deps: UpstreamDeps,
): Promise<UndiciResponse> {
  const doFetch = deps.fetchImpl ?? undiciFetch;

  const resolved = resolveProxy(deps.config, req.proxyId);
  if (!resolved.ok) {
    throw new EgressSetupError(describeResolveFailure(resolved.failure));
  }
  const target = resolved.target;

  const init: UndiciRequestInit = {
    method: req.method,
    headers: { ...req.headers },
    /*
     * 绝不跟随重定向。
     *
     * 请求头里带着 Worker 的上游 key;若跟随一个指向别处的 302,
     * 那个 Bearer key 会被原样发给重定向目标 —— 一个被劫持或配错的上游
     * 就此变成凭证窃取原语。`manual` 让 3xx 原样返回给调用方处理。
     */
    redirect: "manual",
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  };
  // 有体才设 body:GET/HEAD 带 body 会被 fetch 拒绝。
  if (req.body !== null) init.body = req.body;

  // 在真正发出请求的同步片段里取池，尤其不能把 dispatcher 留在 selector
  // 排队或 select() 的 await 之前：期间热更新会优雅关闭那个旧实例。
  const dispatch = (): Promise<UndiciResponse> => {
    req.signal?.throwIfAborted();
    let dispatcher: Dispatcher;
    try {
      dispatcher = deps.dispatchers.get(target);
    } catch (err) {
      throw new EgressSetupError(err instanceof Error ? err.message : "无法建立出口");
    }
    return doFetch(req.url, { ...init, dispatcher });
  };


  if (target.mode !== "bridge") {
    return dispatch();
  }

  const controller = deps.controllerFor(target.bridge.bridgeId);
  if (controller === null) {
    throw new EgressSetupError(`Clash 内核 ${target.bridge.bridgeId} 不存在`);
  }
  const group = bridgeSelectorGroup(deps.config.clash, target.bridge.bridgeId);
  if (group === null) {
    throw new EgressSetupError("内核未配置 selector 分组");
  }

  const lock = deps.locks.forBridge(target.bridge.bridgeId);
  /*
   * 回调返回 `doFetch(...)` 本身(一个 Promise<Response>),
   * 锁因此持到响应头到达即释放。**不要**在这里 await 后读 body ——
   * 见文件头对 Promise 同化的说明。
   *
   * ## `select()` 的失败必须包成 `EgressSetupError`,而 `doFetch()` 的不能
   *
   * 这一条是生产验证查出来的(第六轮),而五个审核 agent 都没查到 —— 因为它
   * 只在**本机 Clash 要求鉴权而配置里没有 secret** 时才出现。
   *
   * 切 selector 是**本机控制面**操作,它失败意味着本机配置不对
   * (Clash 开了鉴权、secret 变了、分组改名),与上面那四处
   * `EgressSetupError` 同类:**换任何 Worker 都不会好**。
   *
   * 不包的后果实测:`ControllerError` 逃出去 → `classifyError` 归 `transport`
   * → `isRetryable` 为真且 `blameWorker` 为真 → 重试链把每个 Worker 依次试
   * 一遍并**各记一次失败进冷却**。于是一个本机 Clash 的 secret 配错,
   * 会把三个健康账号全部打进退避 —— 正是不变量 #4 要保的那件事。
   *
   * 而 `doFetch()` 的失败必须**保持原样**:那是真实的网络失败,换 Worker
   * 可能就成功,该重试也该归咎。所以只包 `select()` 那一句,不包整个回调。
   */
  return lock.run(async () => {
    try {
      await controller.select(group, target.nodeName);
    } catch (err) {
      throw new EgressSetupError(
        err instanceof Error ? err.message : "切换 Clash 出站节点失败",
      );
    }
    if (req.signal?.aborted) {
      throw req.signal.reason ?? new DOMException("操作已取消", "AbortError");
    }
    return dispatch();
  }, req.signal);
}
