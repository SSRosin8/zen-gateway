/**
 * Clash 节点分类的唯一真相，供 Controller 客户端、`setup.mjs` 与订阅解析共用（纪律 #4）。
 * 分组被误当节点导入会让出口隔离静默失效。Controller 返回 `URLTest` 形态，
 * 配置文件写 `url-test` 形态，判定时统一折叠大小写与连字符。
 */

/** Controller `/proxies` 返回的分组/内置策略 type（首字母大写形态）。 */
export const CONTROLLER_GROUP_TYPES = [
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "Direct",
  "Reject",
  "RejectDrop",
  "Pass",
  "Compatible",
  "Dns",
] as const;

/** Clash 配置文件 `proxies:` 里可能混入的分组 type（小写连字符形态）。 */
export const CONFIG_GROUP_TYPES = [
  "select",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
  "direct",
  "reject",
  "dns",
] as const;

/** 归一化：折叠大小写与连字符，`URLTest` 与 `url-test` 归到同一个键。 */
function normalize(type: string): string {
  return type.toLowerCase().replace(/[-_\s]/g, "");
}

const GROUP_KEYS = new Set(
  [...CONTROLLER_GROUP_TYPES, ...CONFIG_GROUP_TYPES].map(normalize),
);

/** 这个 type 是分组或内置策略（而不是可出口的节点）吗？两种书写形态都认。 */
export function isGroupType(type: string): boolean {
  return GROUP_KEYS.has(normalize(type));
}
