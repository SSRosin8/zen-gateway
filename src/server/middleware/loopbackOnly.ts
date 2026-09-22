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
};

/**
 * 中间件:非回环来源一律 403。
 *
 * 用于管理面。转发面(`/v1/*`)另有 Relay Token 保护,且服务本身只监听
 * `127.0.0.1` —— 但监听地址是可配的,而管理面**任何情况下**都不该接受远端,
 * 所以这道闸门不依赖监听地址,而是独立成立。
 */
export function loopbackOnly(options: LoopbackOnlyOptions = {}): MiddlewareHandler {
  const addressOf = options.addressOf ?? ((c: Context) => getConnInfo(c).remote.address);

  return async (c, next) => {
    let address: string | undefined;
    try {
      address = addressOf(c);
    } catch {
      // 拿不到对端地址就当作不可信 —— 不能因为探测失败而放行。
      address = undefined;
    }

    if (!isLoopbackAddress(address)) {
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
}
