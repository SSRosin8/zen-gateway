// 必须用 undici 的 fetch,不是全局 fetch:`dispatcher` 是 undici 特有的选项,
// 全局 fetch 会静默忽略它 —— 于是所有请求都走本机默认出口,出口隔离整体失效
// 且毫无报错。probe.ts 同样从 undici 导入,两处保持一致。
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
 * 这个边界是不变量 #1:重试判定只能看 status + headers,响应体必须
 * 保持未消费,由上层决定是转发给客户端还是丢弃。
 *
 * ## 不变量 #5:selector 锁的范围
 *
 * 桥接出口下「切 selector + 建立连接」必须原子,但锁**不能跨到响应头或响应体**
 * —— 否则一个慢上游或一条长 SSE 会把同一内核上的请求串行化。
 *
 * 临界区的边界是**连接就绪**:经 CONNECT 隧道的连接建立后已绑定到当时选中的
 * 节点,之后再切 selector 不影响这条连接。实现见 `fetchUpstream` 末尾。
 *
 * `.then()` 会自动同化返回的 Promise,所以 `lock.run()` 的回调绝不能返回
 * fetch 或读体的 Promise 本身。这个区别不体现在类型签名上,只能靠注释与测试守住。
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
  const dispatch = (onConnected?: () => void): Promise<UndiciResponse> => {
    req.signal?.throwIfAborted();
    let dispatcher: Dispatcher;
    try {
      dispatcher = deps.dispatchers.get(target);
    } catch (err) {
      throw new EgressSetupError(err instanceof Error ? err.message : "无法建立出口");
    }
    if (onConnected !== undefined) dispatcher = dispatcher.compose(notifyOnConnected(onConnected));
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
   * ## 锁在连接建立时释放,不等响应头
   *
   * Clash 在 CONNECT 建隧道时按当时的 selector 绑定出站节点,之后这条连接终身
   * 走那个节点。undici 在连接(含经隧道的 TLS)就绪、请求开始写出时回调
   * `onRequestStart`,此刻 selector 的选择已经落在连接上,再切换也不影响它。
   * 所以临界区到这里为止;若等到响应头,一个慢上游会把同一内核上的所有
   * 请求串行化。
   *
   * 复用 keep-alive 连接时同样安全:dispatcher 按节点缓存(不变量 #7),
   * 池里的连接都诞生于持锁选中同一节点之时。
   *
   * 这依赖桥接 dispatcher 对 http 目标也走 CONNECT 隧道(`proxyTunnel`,见
   * `dispatcher.ts`):不走隧道时请求以绝对 URI 转发,Clash 读到请求头才拨号,
   * `onRequestStart` 时节点还没选定。
   *
   * 释放取两者中先发生的一次:`onRequestStart`,或 fetch 本身落定(建连前失败
   * 会让 fetch 立即拒绝;注入的 `fetchImpl` 不经 dispatcher 时退化为旧的
   * "响应头到达即释放")。`release` 幂等,锁层只认第一次。
   *
   * 任务返回的是装着 Promise 的**盒子**而不是 Promise 本身:`run()` 的 `.then()`
   * 会同化 thenable,直接返回 fetch 的 Promise 会把锁重新拉长到响应头。
   *
   * ## `select()` 的失败必须包成 `EgressSetupError`,而 `doFetch()` 的不能
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
  const boxed = await lock.run(async () => {
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
    let release!: () => void;
    const connected = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = dispatch(release);
    // 同时充当 rejection 的处理者:盒子交出之前 fetch 就失败也不会成为未处理拒绝。
    response.then(release, release);
    await connected;
    return { response };
  }, req.signal);
  return boxed.response;
}

/**
 * 请求级拦截器:连接就绪、请求开始写出(`onRequestStart`)时通知。
 *
 * 用 Proxy 只替换这一个回调,其余属性读写原样落到 fetch 自己的 handler 上 ——
 * 它在回调里给 `this` 挂 `body`、`abort`,换成手写的转发对象会丢掉这些状态。
 */
function notifyOnConnected(onConnected: () => void): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) =>
    dispatch(
      opts,
      new Proxy(handler, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (key !== "onRequestStart" || typeof value !== "function") {
            return value;
          }
          return function (this: unknown, ...args: unknown[]) {
            onConnected();
            return (value as (...a: unknown[]) => unknown).apply(this, args);
          };
        },
      }),
    );
}
