import type { ProtocolId } from "../../shared/schema.ts";
import type { TokenUsage } from "../models/usage.ts";

/**
 * 协议面接口：新增客户端协议只需实现它并注册。
 *
 * 刻意没有 transformRequest：Zen 为每个面提供原生端点，无需翻译；而 JSON 往返
 * 并非无损（如 `1.0` 变 `1`），违背原样透传。因此方法全部只读，在请求体的解析副本上
 * 判定，转发的始终是原始字节。入参一律 `unknown`，强制实现逐层收窄，避免把 400 变成 500。
 */
export type ProtocolSurface = {
  readonly id: ProtocolId;
  /** 客户端可用的路径,含兼容别名。注册时会检查跨面重复。 */
  readonly clientPaths: readonly string[];
  /** 上游路径,拼在 `gateway.baseUrl` 之后。 */
  readonly upstreamPath: string;
  /** 流式能力。`"none"` 为 jev 这类返回取值与概率的非流式面预留。 */
  readonly streaming: "sse" | "none" | "optional";
  /** 客户端能否用 `x-api-key` 提供 Relay Token（Anthropic SDK 只发它）。省略即不接受。 */
  readonly acceptsApiKeyHeader?: boolean;

  /** 从请求体取模型 id;取不到返回 null(交由调用方报 400)。 */
  extractModel(body: unknown): string | null;
  /** 客户端是否要求流式。 */
  wantsStream(body: unknown): boolean;
  /** 体内会话亲和键；无则返回 undefined，由 `x-opencode-session` 头承担。 */
  sessionKeyFrom(body: unknown): string | undefined;
  /** 从完整响应或 SSE 事件中读取可用于 Responses 续链的响应 id。 */
  responseIdFrom?(payload: unknown): string | null;
  /** 面特有的上游请求头；通用头由 `upstream/headers.ts` 统一处理。 */
  extraUpstreamHeaders(ctx: UpstreamHeaderCtx): Record<string, string>;
  /**
   * 从已解析的 JSON 值（非流式整个体或单个 SSE 事件）取 token 用量；字段归一化在
   * `core/models/usage.ts`。取不到返回 null：「没报用量」必须区别于「0 token」，
   * 否则 usage 覆盖率指标恒为 100%。
   */
  parseUsage(payload: unknown): TokenUsage | null;
};

export type UpstreamHeaderCtx = {
  /** 本次选中 Worker 的上游 key。 */
  readonly apiKey: string;
  readonly streaming: boolean;
};

/** 请求体是否为可取字段的普通对象。数组与 null 都不算。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从请求体读取模型 id。只接受非空且无首尾空白的字符串，不做 trim 或大小写归一化：
 * 它参与免费放行判定，任何两处归一化不一致都是放行漏洞。
 */
export function readModelField(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const model = body["model"];
  if (typeof model !== "string") return null;
  if (model === "" || model.trim() !== model) return null;
  return model;
}

/** 三个面都用 `stream: true` 表达流式,只认真正的布尔真值。 */
export function readStreamField(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return body["stream"] === true;
}
