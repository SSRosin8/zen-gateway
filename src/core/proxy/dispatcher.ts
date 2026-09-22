import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import type { Proxy } from "../../shared/schema.ts";

/**
 * 出口 dispatcher 工厂。
 *
 * 每个代理一个 dispatcher,按 id 缓存复用 —— 每次请求新建会丢掉连接池,
 * 并且在高频下把本地端口耗尽。
 *
 * ## 超时必须分两段(规划的不变量 #6)
 *
 * 用单一的总时长(例如 `AbortSignal.timeout()` 套整个 fetch)会把响应体
 * 一起 abort:一条正常的长 SSE 到点就被掐断。已实测确认 undici 的语义:
 *   - `headersTimeout` 只管「等首字节」,3s 才发头的服务器会在 1s 被掐断
 *   - `bodyTimeout` 只管「字节之间的空闲」,块间隔 3s 在 60s 上限下正常通过,
 *     在 1s 上限下才失败
 * 两者独立,正是我们需要的:等首字节可以严格,流式输出的块间隔必须宽松。
 *
 * ## socks 为什么用 fetch-socks
 *
 * `socks-proxy-agent` 是 `http.Agent`,**没有 `dispatch()`**,undici 的 fetch
 * 根本用不了它(已实测 `instanceof Dispatcher === false`)。`fetch-socks` 的
 * `socksDispatcher` 才是真正的 undici Dispatcher。
 */

/** 能直接做 undici 出口的协议。 */
const SOCKS_TYPES = new Set(["socks4", "socks5"]);
const HTTP_TYPES = new Set(["http", "https"]);

export type TimeoutConfig = {
  /** 等响应头的上限。 */
  headersTimeoutMs: number;
  /** 响应体字节之间的空闲上限。 */
  bodyTimeoutMs: number;
};

/** 桥接所需的本地 Clash 混合端口。 */
export type BridgeEndpoint = {
  bridgeId: string;
  host: string;
  port: number;
};

export type EgressTarget =
  /** 直连:自带 dispatcher。 */
  | { mode: "direct"; proxy: Proxy }
  /** 经本地 Clash 混合端口;出口节点由 selector 决定,需持锁切换。 */
  | { mode: "bridge"; proxy: Proxy; bridge: BridgeEndpoint }
  /** 不走代理,用本机网络出口。 */
  | { mode: "none" };

export class DispatcherError extends Error {
  override readonly name = "DispatcherError";
  readonly proxyId: string | null;

  constructor(message: string, proxyId: string | null) {
    super(message);
    this.proxyId = proxyId;
  }
}

/** 代理是否能直连出口(无需 Clash)。 */
export function isDirectCapable(type: string): boolean {
  const t = type.toLowerCase();
  return SOCKS_TYPES.has(t) || HTTP_TYPES.has(t);
}

/**
 * dispatcher 池。
 *
 * 缓存键必须包含所有影响连接行为的字段 —— 只用 proxy.id 的话,
 * 用户改了端口或口令后仍会复用旧 dispatcher,连到旧地址上。
 */
export class DispatcherPool {
  #cache = new Map<string, { key: string; dispatcher: Dispatcher }>();
  #timeouts: TimeoutConfig;
  #closed = false;

  constructor(timeouts: TimeoutConfig) {
    this.#timeouts = timeouts;
  }

  /** 供 Clash 桥接复用:本机直连出口的 dispatcher。 */
  get(target: EgressTarget): Dispatcher {
    if (this.#closed) throw new DispatcherError("dispatcher 池已关闭", null);

    const id = target.mode === "none" ? "__direct__" : target.proxy.id;
    const key = this.#identityKey(target);

    const cached = this.#cache.get(id);
    if (cached) {
      // 配置变了就丢弃重建,而不是继续用连到旧地址的那个。
      if (cached.key === key) return cached.dispatcher;
      void cached.dispatcher.close().catch(() => {});
      this.#cache.delete(id);
    }

    const dispatcher = this.#create(target);
    this.#cache.set(id, { key, dispatcher });
    return dispatcher;
  }

  #identityKey(target: EgressTarget): string {
    const t = this.#timeouts;
    const timeouts = `${t.headersTimeoutMs}/${t.bodyTimeoutMs}`;
    if (target.mode === "none") return `none|${timeouts}`;

    const p = target.proxy;
    if (target.mode === "bridge") {
      const b = target.bridge;
      return `bridge|${b.bridgeId}|${b.host}:${b.port}|${timeouts}`;
    }
    // 口令参与键,但只用长度而非明文 —— 键会进日志与诊断输出。
    const auth = `${p.username ?? ""}:${(p.password ?? "").length}`;
    return `direct|${p.type}|${p.host}:${p.port}|${auth}|${timeouts}`;
  }

  #create(target: EgressTarget): Dispatcher {
    const { headersTimeoutMs, bodyTimeoutMs } = this.#timeouts;
    const common = { headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs };

    if (target.mode === "none") return new Agent(common);

    if (target.mode === "bridge") {
      // 桥接统一走本地混合端口;走哪个节点由 selector 决定(需持锁切换)。
      const { host, port } = target.bridge;
      return new ProxyAgent({ uri: `http://${host}:${port}`, ...common });
    }

    const p = target.proxy;
    const type = p.type.toLowerCase();

    if (SOCKS_TYPES.has(type)) {
      const auth =
        p.username !== undefined && p.username !== ""
          ? { userId: p.username, password: p.password ?? "" }
          : {};
      return socksDispatcher(
        {
          type: type === "socks4" ? 4 : 5,
          host: p.host,
          port: p.port,
          ...auth,
        },
        common,
      );
    }

    if (HTTP_TYPES.has(type)) {
      // 凭证放在 token 而不是 URL 里:URL 形态会让口令出现在任何打印 uri 的地方。
      const token =
        p.username !== undefined && p.username !== ""
          ? `Basic ${Buffer.from(`${p.username}:${p.password ?? ""}`).toString("base64")}`
          : undefined;
      return new ProxyAgent({
        uri: `${type}://${p.host}:${p.port}`,
        ...(token !== undefined ? { token } : {}),
        ...common,
      });
    }

    throw new DispatcherError(
      `代理 ${p.id} 的协议 ${p.type} 无法直连出口,需经 Clash 桥接`,
      p.id,
    );
  }

  /** 配置变更后整体失效。 */
  async reset(): Promise<void> {
    const all = [...this.#cache.values()];
    this.#cache.clear();
    await Promise.allSettled(all.map((e) => e.dispatcher.close()));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.reset();
  }

  get size(): number {
    return this.#cache.size;
  }
}
