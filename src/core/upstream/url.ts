/**
 * 上游 URL 拼接。
 *
 * 不能直接 `new URL(upstreamPath, baseUrl)`:以 `/` 开头的 path 会替换 base 的整个路径
 * (`/zen/v1` 丢失),base 不以 `/` 结尾时最后一段会被替换,症状都是 404。
 * `clash/controller.ts` 用同一套规则。
 */

/**
 * 把 baseUrl 与协议面的 upstreamPath 拼成最终 URL。
 * `baseUrl` 已由 schema 保证是 http/https 且不含内嵌凭证;query 与 fragment 会被丢弃。
 */
export function upstreamUrl(baseUrl: string, upstreamPath: string): string {
  // 去掉前导 `/`,否则会替换掉 base 的整个 path。
  const relative = upstreamPath.replace(/^\/+/, "");
  return new URL(relative, directoryBase(baseUrl)).toString();
}

/**
 * 归一化为「origin + pathname + 末尾斜杠」，供相对路径解析：query/fragment 对端点无意义且会污染
 * 相对解析，缺末尾斜杠时最后一段会被当作文件名替换掉。Clash Controller 的 `apiBase` 同样适用。
 */
export function directoryBase(url: string): URL {
  const base = new URL(url);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}
