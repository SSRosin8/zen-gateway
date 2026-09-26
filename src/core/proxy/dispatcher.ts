import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import type { Proxy } from "../../shared/schema.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { credentialFingerprint } from "./credentialFingerprint.ts";

/**
 * 出口 dispatcher 工厂。每个代理一个 dispatcher 并缓存复用,避免丢掉连接池与耗尽本地端口。
 *
 * 超时分两段(不变量 #6):`headersTimeout` 只管等首字节,`bodyTimeout` 只管块间空闲;
 * 总时长超时会掐断正常的长 SSE。socks 用 fetch-socks:`socks-proxy-agent` 是 `http.Agent`,
 * 没有 `dispatch()`,undici fetch 用不了。
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
  /** 经本地 Clash 混合端口,节点由 selector 决定;`nodeName` 必须参与 dispatcher 身份。 */
  | { mode: "bridge"; proxy: Proxy; bridge: BridgeEndpoint; nodeName: string }
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
 * dispatcher 池。缓存键包含所有影响连接行为的字段,否则改端口或口令后仍复用旧 dispatcher。
 *
 * 桥接时 `nodeName` 必须参与身份(不变量 #7):Clash 在建连时绑定节点,undici 复用
 * keep-alive 连接会让刚做的 `select()` 失效,出口停在旧节点,`applyProbeResult`
 * 还会把错误的 IP 写进 `egressIp`。一个 dispatcher 只服务一个节点,复用才安全。
 */
export class DispatcherPool {
  #cache = new Map<string, { key: string; dispatcher: Dispatcher }>();
  #timeouts: TimeoutConfig;
  #closed = false;

  constructor(timeouts: TimeoutConfig) {
    this.#timeouts = timeouts;
  }

  /** 按出口目标取 dispatcher;身份键变化时丢弃旧实例重建。 */
  get(target: EgressTarget): Dispatcher {
    if (this.#closed) throw new DispatcherError("dispatcher 池已关闭", null);

    // 用共享常量:这个 id 同时被 `IdSchema` 拒绝(纪律 #4)。
    const id = target.mode === "none" ? DIRECT_EGRESS_ID : target.proxy.id;
    const key = this.#identityKey(target);

    const cached = this.#cache.get(id);
    if (cached) {
      // 配置变了就丢弃重建。
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
      // nodeName 必须在键里,见类注释。
      return `bridge|${b.bridgeId}|${b.host}:${b.port}|${target.nodeName}|${timeouts}`;
    }
    // 口令用摘要参与键,规则见 credentialFingerprint.ts。
    const auth = `${p.username ?? ""}:${credentialFingerprint(p.password ?? "")}`;
    return `direct|${p.type.toLowerCase()}|${p.host}:${p.port}|${auth}|${timeouts}`;
  }

  #create(target: EgressTarget): Dispatcher {
    const { headersTimeoutMs, bodyTimeoutMs } = this.#timeouts;
    const common = { headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs };

    if (target.mode === "none") return new Agent(common);

    if (target.mode === "bridge") {
      // 强制 CONNECT 隧道:让节点在建隧道时就绑定,selector 锁才能在连接就绪时释放(见 fetch.ts)。
      const { host, port } = target.bridge;
      return new ProxyAgent({ uri: `http://${host}:${port}`, proxyTunnel: true, ...common });
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

  /** 不再接受新请求;已开始的响应流读完后连接才关闭。 */
  async close(): Promise<void> {
    this.#closed = true;
    const all = [...this.#cache.values()];
    this.#cache.clear();
    await Promise.allSettled(all.map((e) => e.dispatcher.close()));
  }

  /**
   * 立即断开缓存中 dispatcher 的全部连接,之后拒绝再取。
   * 只对尚未 `close()` 的 dispatcher 有效(Agent close 时即清空客户端表),所以停机不先 close 再 destroy。
   */
  destroy(): void {
    this.#closed = true;
    const all = [...this.#cache.values()];
    this.#cache.clear();
    for (const e of all) void e.dispatcher.destroy().catch(() => {});
  }
}
