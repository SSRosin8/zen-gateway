/**
 * IP 字面量校验与规范化。
 *
 * ## 为什么不用 `node:net` 的 `isIP`
 *
 * 本模块在 `src/shared/` 下,是 server ⇄ admin ⇄ CLI 的共享契约层 ——
 * `schema.ts` 要用它校验 `egressIp`,而 `schema.ts` 会被管理后台的浏览器包
 * 一起打进去。`import { isIP } from "node:net"` 会让 Vite 构建直接失败。
 *
 * ## 为什么不自己写 IPv6 解析器
 *
 * 试过,错了。手写版只检查「全是十六进制与冒号、`::` 不超过一个、段数 ≤8」,
 * 对着 `node:net.isIP` 做 20 万次结构化模糊测试跑出 **2653 处分歧**,
 * 全是放得太宽:`":::"`、`"1:::2"`、`"abcd::ffff:"`、`"1::0:"`、`"0:::1"` 等
 * 尾随/连续冒号形态统统被接受。
 *
 * 现在改用 **WHATWG URL 的 host 解析器**:它实现了严格的 IPv6 语法,
 * 且浏览器与 Node 都内置。实测在 22 个针对性用例上与 `node:net.isIP`
 * **完全一致**(含上面所有手写版放过的形态)。
 * zone id(`%eth0`)URL 不接受,单独按 `node:net` 的规则处理:
 * 恰好一个 `%`、zone 非空、不含空白。
 *
 * ## 为什么必须严格
 *
 * `egressIp` 是**出口隔离的分组键**。一个被劫持的回显服务返回 `"::"`
 * 就能变成一条「出口 IP」记录;而任意垃圾值会各自成组,看起来全都不同
 * —— **误报已隔离**,恰好把这个项目唯一要回答的问题答错。
 *
 * `tests/unit/ip.test.ts` 拿 `node:net.isIP` 当基准做对照与模糊测试
 * (测试跑在 Node 里,可以用它当权威答案)。
 */

/** IPv4:四段十进制,不允许前导零(`010` 在不同解析器里含义不同)。 */
function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part[0] === "0") return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/** 把地址拆成「地址主体」与「zone id」。zone 非法时返回 null。 */
function splitZone(value: string): { addr: string; zone: string | undefined } | null {
  const first = value.indexOf("%");
  if (first === -1) return { addr: value, zone: undefined };

  const zone = value.slice(first + 1);
  // node:net 的规则:zone 非空、不含第二个 %、不含空白。
  if (zone === "" || zone.includes("%") || /\s/.test(zone)) return null;
  return { addr: value.slice(0, first), zone };
}

/** 交给 WHATWG URL 的 host 解析器判定 IPv6 —— 见文件头说明。 */
function isIpv6Addr(addr: string): boolean {
  try {
    // 合法 IPv6 会被 URL 规范化成带方括号的 hostname。
    return new URL(`http://[${addr}]`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

/** 合法的 IPv4 或 IPv6 字面量(IPv6 可带 zone id)。 */
export function isIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  // 前后空白一律拒绝:回显服务的响应已 trim 过,此处收到空白说明格式不对。
  if (value !== value.trim()) return false;

  if (!value.includes(":")) return isIpv4(value);

  const split = splitZone(value);
  if (split === null) return false;
  return isIpv6Addr(split.addr);
}

/**
 * 把 IP 规范化为可比较的形式。
 *
 * 出口隔离按 IP 分组,而分组用字符串相等 —— 同一个地址的两种写法会被分成
 * 两组,于是**误报「已隔离」**。这不是理论问题:四个回显服务各自格式化
 * IPv6 的方式不同,而探测会在它们之间自由回退,所以 worker A 经 ipify 拿到
 * `2001:db8:0:0:0:0:0:1`、worker B 经 ip.sb 拿到 `2001:DB8::1` 是完全可能的
 * —— 同一地址,两组,`isolated: true`。
 *
 * URL 的 host 解析器按 RFC 5952 压缩并小写化,顺带把 `::ffff:1.2.3.4`
 * 归一到十六进制形态。
 */
export function canonicalizeIp(value: string): string {
  if (!isIpAddress(value)) return value.trim().toLowerCase();
  if (!value.includes(":")) return value; // IPv4 只有一种写法

  const split = splitZone(value);
  if (split === null) return value.trim().toLowerCase();

  try {
    const hostname = new URL(`http://[${split.addr}]`).hostname;
    const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    return split.zone === undefined ? bare : `${bare}%${split.zone}`;
  } catch {
    return value.trim().toLowerCase();
  }
}
