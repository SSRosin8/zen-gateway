import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/**
 * 仅回环访问。
 *
 * ## 绝不采信 `X-Forwarded-For`
 *
 * 这是本文件最重要的一条。该头由客户端任意设置,任何反向代理都能伪造 ——
 * 若用它判断来源,一个远端请求只要带上 `X-Forwarded-For: 127.0.0.1`
 * 就能拿到管理面权限。唯一可信的来源证据是**内核报告的 TCP 对端地址**。
 *
 * 本文件因此只读 `getConnInfo(c).remote.address`,不读任何请求头。
 *
 * ## 为什么用 `net.BlockList` 而不是比较字符串
 *
 * 朴素写法 `addr === "127.0.0.1" || addr === "::1"` 有两个洞,
 * 而且第二个会让**正常请求被拒**:
 *
 * 1. 回环是整个 `127.0.0.0/8`,不止 `.0.1`。`127.0.0.2` 同样是本机。
 * 2. **双栈监听下,经 IPv4 连来的客户端被报成 IPv4-mapped IPv6。**
 *    实测:客户端连 `127.0.0.1`,`getConnInfo` 报的是 `::ffff:127.0.0.1`。
 *    朴素比较会把这个**合法的本机请求**判为非回环。
 *
 * `BlockList` 两者都处理对了(实测 `::ffff:127.0.0.1` → true,
 * `::ffff:7f00:1` 这种十六进制写法也 → true)。手写 CIDR 与 IPv6 形态
 * 解析在本项目已错过两次且都是「放得太宽」,这里用内置实现。
 */

/** 回环地址集合。构造一次复用 —— 每请求新建是无谓的开销。 */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** 判断一个地址是否为回环。无法识别的地址一律判否(默认拒绝)。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address === "") return false;

  const version = isIP(address);
  if (version === 4) return LOOPBACK.check(address, "ipv4");
  if (version === 6) return LOOPBACK.check(address, "ipv6");

  /*
   * 既不是 IPv4 也不是 IPv6 —— 例如 Unix domain socket 下的空地址,
   * 或某个我们没预料到的形态。默认拒绝:一个认不出来的来源不该被当作本机。
   */
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
 * 标记属性 —— 让装配期断言能**按身份**认出这道闸门。
 *
 * `app.ts` 的 `assertAdminRoutesLoopbackOnly` 要验证「`/api/*` 下每条路由都被
 * **回环闸门**覆盖」，而只比路径形状是不够的：「`/api/*` 上挂了某个中间件」
 * 并不能说明挂的是这一个。用一个不可枚举的符号属性做标记，据此精确识别。
 *
 * 用 `Symbol` 而不是字符串属性:避免与 Hono 或用户代码的属性名相撞,
 * 也不会出现在 `JSON.stringify` 或 `Object.keys` 里。
 */
export const LOOPBACK_GUARD = Symbol("zen-gateway.loopbackOnly");

/** 这个中间件是不是回环闸门。供装配期断言使用。 */
export function isLoopbackGuard(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  return (handler as unknown as Record<symbol, unknown>)[LOOPBACK_GUARD] === true;
}

/**
 * 中间件:非回环来源一律 403。
 *
 * 用于管理面。转发面(`/v1/*`)另有 Relay Token 保护,且服务本身只监听
 * `127.0.0.1` —— 但监听地址是可配的,而管理面**任何情况下**都不该接受远端,
 * 所以这道闸门不依赖监听地址,而是独立成立。
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
      /*
       * 不回显对端地址。
       *
       * 它对合法用户毫无帮助(他们本来就在本机),对扫描者却是一条确认信号
       * 「这里有个只认本机的管理面」。措辞保持中立。
       */
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
