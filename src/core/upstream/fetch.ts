// 必须用 undici 的 fetch:全局 fetch 会静默忽略 `dispatcher`,出口隔离整体失效且无报错。
// 类型也取自 undici,它的 RequestInit 才有 `dispatcher`。
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
 * 单次上游请求:经指定出口发出,拿到响应头;不做重试、不读响应体(不变量 #1)。
 *
 * 不变量 #5:桥接下「切 selector + 建连」必须原子,锁不能跨到响应头或响应体。
 * 不变量 #7:dispatcher 按节点缓存,`nodeName` 由 `resolveProxy` 单点提供,这里不自己算,
 * 否则会出现「锁切到 A 而 dispatcher 属于 B」。
 */

export type UpstreamRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** 原始请求体字节,原样透传。 */
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
 * 发出一次上游请求,返回响应体未被消费的 Response。
 * 出口配置问题抛 `EgressSetupError`:换任何 Worker 都不会好,须与网络失败区分。
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
    // 绝不跟随重定向:302 会把 Worker 的 Bearer key 原样发给重定向目标。
    redirect: "manual",
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  };
  // 有体才设 body:GET/HEAD 带 body 会被 fetch 拒绝。
  if (req.body !== null) init.body = req.body;

  // 在真正发出请求的同步片段里取池:若在 selector 排队或 select() 之前取,期间热更新会关闭旧实例。
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
   * 锁在连接就绪(`onRequestStart`)时释放,不等响应头:Clash 在 CONNECT 建隧道时绑定节点,
   * 之后切换不影响该连接;keep-alive 复用也安全(不变量 #7)。这依赖桥接 dispatcher 对 http
   * 目标也走隧道(`proxyTunnel`,见 `dispatcher.ts`)。建连前失败或注入的 `fetchImpl` 时,
   * 以 fetch 落定释放;`release` 幂等。任务返回装着 Promise 的盒子,避免 `.then()` 同化把锁拉长。
   *
   * 只把 `select()` 的失败包成 `EgressSetupError`:本机控制面出错时若归为 transport,
   * 重试链会把所有健康 Worker 打进冷却(不变量 #4)。`doFetch()` 的失败是真实网络失败,保持原样。
   */
  const boxed = await lock.run(async () => {
    try {
      await controller.select(group, target.nodeName);
    } catch (err) {
      throw new EgressSetupError(
        err instanceof Error ? err.message : "切换 Clash 出站节点失败",
      );
    }
    req.signal?.throwIfAborted();
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
 * 用 Proxy 只替换这一个回调:fetch 会在 handler 的 `this` 上挂状态,手写转发对象会丢掉它们。
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
