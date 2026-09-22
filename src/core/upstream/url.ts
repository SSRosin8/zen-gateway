/**
 * 上游 URL 拼接。
 *
 * ## 为什么需要一个专门的函数
 *
 * 朴素写法 `new URL(surface.upstreamPath, config.gateway.baseUrl)` 是**错的**:
 * WHATWG 的相对解析里,以 `/` 开头的路径是**绝对路径**,会替换掉 base 的
 * 整个 path。实测:
 *
 *   new URL("/chat/completions", "https://opencode.ai/zen/v1")
 *     → "https://opencode.ai/chat/completions"     ← /zen/v1 被丢掉
 *
 * 于是请求打到一个不存在的端点,症状是 404,而用户会以为是模型不存在。
 * 同类陷阱:base 不以 `/` 结尾时,最后一段会被当作「文件名」而被替换:
 *
 *   new URL("chat/completions", "https://opencode.ai/zen/v1")
 *     → "https://opencode.ai/zen/chat/completions"  ← v1 被替换
 *
 * 正确做法是把 base 规范成以 `/` 结尾,并把 path 变成不以 `/` 开头的相对路径。
 * `clash/controller.ts` 里有同样的处理 —— 两处独立犯过同一个错,
 * 所以这里用同一套规则并写明原因。
 */

/**
 * 把 baseUrl 与协议面的 upstreamPath 拼成最终 URL。
 *
 * `baseUrl` 已由 schema 保证是 http/https 且不含内嵌凭证。
 * query 与 fragment 会被丢弃:它们对「端点地址」没有意义,
 * 而带着它们做相对解析会得到一个永远到不了的地址。
 */
export function upstreamUrl(baseUrl: string, upstreamPath: string): string {
  const base = new URL(baseUrl);
  // query/fragment 对端点无意义,且会污染相对解析。
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  // 去掉前导 `/`,否则会替换掉 base 的整个 path(见文件头)。
  const relative = upstreamPath.replace(/^\/+/, "");
  return new URL(relative, base).toString();
}
