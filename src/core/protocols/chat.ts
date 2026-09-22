import type { ProtocolSurface } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";

/**
 * OpenAI Chat Completions 面 —— Phase 3 的第一个面。
 *
 * 选它做第一个不是随意:OpenCode 默认就用这个面访问 Zen,
 * 所以它是「第一个真实请求端到端成功」这个门槛唯一能验的面。
 *
 * `/v1/chat/completions` 与 `/chat/completions` 两条路径都收:
 * 客户端配置里的 baseUrl 写成 `http://127.0.0.1:9876/v1` 还是
 * `http://127.0.0.1:9876` 都很常见,少一条别名就会得到一个 404,
 * 而那个 404 对用户表现为「网关没反应」,极难自查。
 */
export const chatSurface: ProtocolSurface = {
  id: "chat",
  clientPaths: ["/v1/chat/completions", "/chat/completions"],
  upstreamPath: "/chat/completions",
  streaming: "optional",

  extractModel: readModelField,
  wantsStream: readStreamField,

  /**
   * Chat 面的请求体里没有会话标识。
   *
   * 会话亲和在这个面上完全依赖 `x-opencode-session` 头 ——
   * 这正是「该头必须强制注入且经校验」的原因:它是本面唯一的粘滞依据。
   */
  sessionKeyFrom(): string | undefined {
    return undefined;
  },

  /** 本面无特有头;鉴权与 OpenCode 身份头由 upstream/headers.ts 统一加。 */
  extraUpstreamHeaders(): Record<string, string> {
    return {};
  },
};

/**
 * `/v1/models` 不是协议面,而是网关自己回答的目录查询。
 *
 * 放在这里只为集中定义路径常量,避免 routes 与测试各写一份字符串。
 */
export const MODELS_PATHS = ["/v1/models", "/models"] as const;

/** 判断请求体是否为「至少形状合法」的 chat 请求,用于 400 早退。 */
export function looksLikeChatBody(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return Array.isArray(body["messages"]);
}
