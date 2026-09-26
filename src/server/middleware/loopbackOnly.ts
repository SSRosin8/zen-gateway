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
};

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

    if (
      !isLoopbackAddress(address) ||
      (host !== undefined && !isLoopbackHost(host)) ||
      !isAllowedOrigin(origin)
    ) {
      // 不回显对端地址：对合法用户无用，对扫描者是确认信号。
      return c.json(
        { error: { type: "forbidden", message: "管理接口仅接受本机访问" } },
        403,
      );
    }

    return next();
  };

  // 见 LOOPBACK_GUARD 的说明:装配期断言靠它按身份识别这道闸门。
  Object.defineProperty(guard, LOOPBACK_GUARD, { value: true, enumerable: false });
  return guard;
}
