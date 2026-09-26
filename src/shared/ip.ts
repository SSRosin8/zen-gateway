/**
 * IP 字面量校验与规范化。`src/shared/` 进入浏览器构建，不能用 `node:net`；
 * IPv6 交给 WHATWG URL 的 host 解析器，不手写解析器（纪律 #5）。
 * zone id（`%eth0`）URL 不接受，按 `node:net` 规则单独处理。
 * `tests/unit/ip.test.ts` 以 `node:net.isIP` 为基准做对照与模糊测试。
 */

/** IPv4：四段十进制，不允许前导零（`010` 在不同解析器里含义不同）。 */
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
  // node:net 的规则：zone 非空、不含第二个 %、不含空白。
  if (zone === "" || zone.includes("%") || /\s/.test(zone)) return null;
  return { addr: value.slice(0, first), zone };
}

/** 交给 WHATWG URL 的 host 解析器判定 IPv6。 */
function isIpv6Addr(addr: string): boolean {
  try {
    // 合法 IPv6 会被 URL 规范化成带方括号的 hostname。
    return new URL(`http://[${addr}]`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

/** 合法的 IPv4 或 IPv6 字面量（IPv6 可带 zone id）。 */
export function isIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  // 回显响应已 trim 过，此处收到前后空白说明格式不对。
  if (value !== value.trim()) return false;

  if (!value.includes(":")) return isIpv4(value);

  const split = splitZone(value);
  if (split === null) return false;
  return isIpv6Addr(split.addr);
}

/**
 * 把 IP 规范化为可比较的形式：回显报告按字符串分组，同一地址的不同写法
 * 会误报「已隔离」。URL 的 host 解析器按 RFC 5952 压缩并小写化。
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
