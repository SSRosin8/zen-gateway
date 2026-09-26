import type { ProtocolSurface } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

/**
 * OpenAI Chat Completions 面（OpenCode 默认访问 Zen 的面）。
 * 同时收 `/v1` 前缀与无前缀路径：客户端 baseUrl 两种写法都常见，少一条别名就是难自查的 404。
 */
export const chatSurface: ProtocolSurface = {
  id: "chat",
  clientPaths: ["/v1/chat/completions", "/chat/completions"],
  upstreamPath: "/chat/completions",
  streaming: "optional",

  extractModel: readModelField,
  wantsStream: readStreamField,

  /** 体内无会话标识；亲和完全依赖 `x-opencode-session` 头。 */
  sessionKeyFrom(): string | undefined {
    return undefined;
  },

  responseIdFrom(): string | null {
    return null;
  },

  /** 本面无特有头;鉴权与 OpenCode 身份头由 upstream/headers.ts 统一加。 */
  extraUpstreamHeaders(): Record<string, string> {
    return {};
  },

  /**
   * 用量只在顶层 `usage`（流式在末帧）。刻意不认其他面的嵌套信封，
   * 否则接错面不会产生任何症状，只是统计静默变错。
   */
  parseUsage(payload: unknown): TokenUsage | null {
    if (!isRecord(payload)) return null;
    return readUsage(payload["usage"]);
  },
};

/** `/v1/models` 不是协议面而是网关自答的目录查询；集中定义路径常量。 */
export const MODELS_PATHS = ["/v1/models", "/models"] as const;

