import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/**
 * 仅回环访问。只读内核报告的 TCP 对端地址（`getConnInfo`），绝不采信可伪造的 `X-Forwarded-For`。
 * 用 `net.BlockList` 判定（纪律 #5）：回环是整个 `127.0.0.0/8`，双栈下 IPv4 客户端
 * 会被报成 `::ffff:127.0.0.1`，朴素字符串比较会误判。
 */

/** 回环地址集合，构造一次复用。 */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** 判断一个地址是否为回环。无法识别的地址一律判否(默认拒绝)。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === "") return false;

  const version = isIP(address);
  if (version === 4) return LOOPBACK.check(address, "ipv4");
  if (version === 6) return LOOPBACK.check(address, "ipv6");

  // 认不出的来源（如 Unix socket 的空地址）默认拒绝。
  return false;
}

export type LoopbackOnlyOptions = {
  /** 注入以便测试,不必起真 socket。 */
  readonly addressOf?: (c: Context) => string | undefined;
  readonly hostOf?: (c: Context) => string | undefined;
  readonly originOf?: (c: Context) => string | undefined;
  /**
   * 局域网访问：TCP 对端仍须是回环（局域网请求经本机 Vite 转发进来），但 Host/Origin
   * 可以是局域网地址，此时由它判定。返回 true 放行；`isPublic` 的路径（登录、状态）
   * 对局域网请求免会话。不传 = 只接受本机 Host。
   */
  readonly lan?: {
    /** 未设置口令时局域网请求与以前一样 403，连登录端点也不开放。 */
    readonly enabled: () => boolean;
    readonly allowed: (c: Context) => boolean;
    readonly isPublic: (path: string) => boolean;
  };
};

/**
 * 管理后台站点（`server/adminSite.ts`）为真实对端不是回环的请求打的标记。带标记的请求
 * 一律按局域网请求处理，Host 写成回环也冒充不了本机。Symbol 键，客户端无法伪造。
 */
export const LAN_PEER = Symbol("zen-gateway.lanPeer");

function isLanPeer(c: Context): boolean {
  return (c.env as Record<symbol, unknown> | undefined)?.[LAN_PEER] === true;
}

/** 请求是否来自本机浏览器（对端、Host 与 Origin 都是回环）。供局域网相关端点区分来源。 */
export function isLocalRequest(c: Context): boolean {
  if (isLanPeer(c)) return false;
  const host = c.req.header("host");
  return (host === undefined || isLoopbackHost(host)) && isAllowedOrigin(c.req.header("origin"));
}

function isLoopbackHost(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  try {
    const parsed = new URL(`http://${value}`);
    // Host 头只允许 authority；拒绝 userinfo、路径与 query，避免把 URL
    // 语法的宽松解析误当作合法的 HTTP Host。
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return false;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || isLoopbackAddress(host);
  } catch {
    return false;
  }
}

function isAllowedOrigin(value: string | undefined): boolean {
  // 没有 Origin 的同源/非浏览器请求兼容放行；显式空值是畸形来源，拒绝。
  if (value === undefined) return true;
  if (value === "") return false;
  try {
    const origin = new URL(value);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.username === "" &&
      origin.password === "" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === "" &&
      isLoopbackHost(origin.host)
    );
  } catch {
    return false;
  }
}

/** 私网地址段（RFC 1918 与 IPv6 ULA）：局域网访问只认这些 IP 字面量作 Host。 */
const PRIVATE = new BlockList();
for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]) {
  const [net, bits] = cidr.split("/") as [string, string];
  PRIVATE.addSubnet(net, Number(bits), isIP(net) === 6 ? "ipv6" : "ipv4");
}

/** 地址是否在局域网访问接受的私网段里。`lanAccess.ts` 列出可访问地址时用同一判据。 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? PRIVATE.check(ip, "ipv4") : v === 6 ? PRIVATE.check(ip, "ipv6") : false;
}

function isPrivateIpHost(value: string): boolean {
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "") return false;
    return isPrivateAddress(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * 局域网请求的 Origin 必须与 Host 同源（或没有 Origin）：否则局域网里别的网页可以借用户已登录的
 * cookie 发跨站写请求。cookie 另有 `SameSite=Strict`，这里是第二道。
 */
function isSameOriginLan(host: string, origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const o = new URL(origin);
    return (o.protocol === "http:" || o.protocol === "https:") && o.host === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 标记属性，让 `app.ts` 的装配期断言按身份（而非路径形状）认出这道闸门。
 * 用不可枚举的 Symbol，避免与其他属性名相撞。
 */
export const LOOPBACK_GUARD = Symbol("zen-gateway.loopbackOnly");

/** 这个中间件是不是回环闸门。供装配期断言使用。 */
export function isLoopbackGuard(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  return (handler as unknown as Record<symbol, unknown>)[LOOPBACK_GUARD] === true;
}

/**
 * 非回环来源一律 403。用于管理面：监听地址可配，这道闸门不依赖它独立成立。
 * 开启局域网访问时见 `LoopbackOnlyOptions.lan`。
 */
export function loopbackOnly(options: LoopbackOnlyOptions = {}): MiddlewareHandler {
  const addressOf = options.addressOf ?? ((c: Context) => getConnInfo(c).remote.address);
  const hostOf = options.hostOf ?? ((c: Context) => c.req.header("host"));
  const originOf = options.originOf ?? ((c: Context) => c.req.header("origin"));

  const guard: MiddlewareHandler = async (c, next) => {
    let address: string | undefined;
    try {
      address = addressOf(c);
    } catch {
      // 拿不到对端地址就当作不可信 —— 不能因为探测失败而放行。
      address = undefined;
    }

    let host: string | undefined;
    let origin: string | undefined;
    try {
      host = hostOf(c);
      origin = originOf(c);
    } catch {
      // 取来源头失败时按不可信处理,不把中间件/测试注入异常变成放行。
      host = undefined;
      origin = "\u0000";
    }

    // 对端不是回环时无论口令一律拒绝：网关只监听回环，能到这里的非回环对端说明监听被改动过。
    // 不回显对端地址：对合法用户无用，对扫描者是确认信号。
    const forbidden = () =>
      c.json({ error: { type: "forbidden", message: "管理接口仅接受本机访问" } }, 403);
    if (!isLoopbackAddress(address)) return forbidden();
    const lanPeer = isLanPeer(c);
    if (!lanPeer && (host === undefined || isLoopbackHost(host)) && isAllowedOrigin(origin)) return next();

    // 局域网请求：Host 必须是私网 IP 字面量（域名会让 DNS rebinding 借道），Origin 同源。
    const lan = options.lan;
    if (
      lan === undefined ||
      !lan.enabled() ||
      host === undefined ||
      !isPrivateIpHost(host) ||
      !isSameOriginLan(host, origin)
    ) {
      return forbidden();
    }
    if (lan.isPublic(c.req.path) || lan.allowed(c)) return next();
    return c.json({ error: { type: "lan_login_required", message: "局域网访问需要先输入访问口令" } }, 401);
  };

  // 见 LOOPBACK_GUARD 的说明:装配期断言靠它按身份识别这道闸门。
  Object.defineProperty(guard, LOOPBACK_GUARD, { value: true, enumerable: false });
  return guard;
}
