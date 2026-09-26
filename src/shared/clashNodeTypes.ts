/**
 * Clash 节点分类的唯一真相。
 *
 * ## 为什么这份清单要单独成文件
 *
 * 「哪些 `type` 不是可出口的节点」这件事有**三个**消费者：
 * Controller 客户端（枚举节点时跳过分组）、`setup.mjs`（同样的枚举）、
 * 订阅解析（Clash YAML 的 `proxies` 里同样会混进分组）。
 *
 * 各写一份就是三份手写副本 —— 手写副本必然分叉，而分叉的症状很难看出来：
 * 一个 `URLTest` 分组被当成节点导入，它「能连」（Clash 会按策略转发），
 * 于是出口隔离静默失效 —— 两个 Worker 走同一个分组会拿到同一个出口。
 *
 * 所以定义收在这一处（与「进程身份判定」是同一个做法：
 * 第二个消费者出现时才抽，但一定要抽）。
 *
 * ## 大小写
 *
 * Controller 的 `/proxies` 返回首字母大写（`Selector`/`URLTest`），
 * 而 Clash **配置文件**里写的是小写连字符（`select`/`url-test`）。
 * 两种形态都要认，所以判定函数统一折叠大小写与连字符。
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

/**
 * Clash 配置文件 `proxies:` 里可能出现的分组 type（小写连字符形态）。
 *
 * 严格说分组该写在 `proxy-groups:` 而不是 `proxies:`，但实测有订阅
 * 把它们混在一起给（尤其是被中间层重新打包过的订阅）。
 */
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

/**
 * 这个 type 是分组或内置策略（而不是一个可出口的节点）吗？
 *
 * 三个消费者共用它 —— 见文件头。两种书写形态都认。
 */
export function isGroupType(type: string): boolean {
  return GROUP_KEYS.has(normalize(type));
}
