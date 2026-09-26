import type { ProtocolSurface } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

/**
 * OpenAI Responses 面。唯一带体内会话指针 `previous_response_id` 的面；
 * 它优先于 `x-opencode-session` 头，因为它指明这次要接哪个响应，
 * 更接近「上游推理块归谁签发」这个真问题。上游对本面只需 Bearer。
 */
export const responsesSurface: ProtocolSurface = {
  id: "responses",
  clientPaths: ["/v1/responses", "/responses"],
  upstreamPath: "/responses",
  // 非流式响应是完整 JSON 对象，所以是 "optional" 而非 "sse"。
  streaming: "optional",

  extractModel: readModelField,
  wantsStream: readStreamField,

  /**
   * 只认非空字符串：`previous_response_id: null` 表示新链，当成键会让所有新链共享绑定。
   * 长度校验归 `normalizeSessionKey`。
   */
  sessionKeyFrom(body: unknown): string | undefined {
    if (!isRecord(body)) return undefined;
    const id = body["previous_response_id"];
    if (typeof id !== "string" || id === "") return undefined;
    return id;
  },

  responseIdFrom(payload: unknown): string | null {
    if (!isRecord(payload)) return null;
    const direct = payload["id"];
    if (typeof direct === "string" && direct !== "") return direct;
    const response = payload["response"];
    if (!isRecord(response)) return null;
    const id = response["id"];
    return typeof id === "string" && id !== "" ? id : null;
  },

  /** 本面无特有头;鉴权与 OpenCode 身份头由 upstream/headers.ts 统一加。 */
  extraUpstreamHeaders(): Record<string, string> {
    return {};
  },

  /** 非流式在顶层 `usage`，流式 `response.completed` 事件在 `response.usage`。 */
  parseUsage(payload: unknown): TokenUsage | null {
    if (!isRecord(payload)) return null;
    const direct = readUsage(payload["usage"]);
    if (direct !== null) return direct;
    const response = payload["response"];
    if (!isRecord(response)) return null;
    return readUsage(response["usage"]);
  },
};
