import type { ProtocolSurface, UpstreamHeaderCtx } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

/**
 * Anthropic Messages 面。
 *
 * 必须把 key 镜像到 `x-api-key`：上游本面只从该头读凭证，仅带 Bearer 会返回 500，
 * 500 归为可重试的 upstream_error，会把整池 Worker 打进冷却（不变量 #4）。
 * `headers.ts` 剥掉客户端的 `x-api-key`，所以镜像只能由本面的 `extraUpstreamHeaders`
 * 加（`UpstreamHeaderCtx.apiKey` 的唯一读者）。
 *
 * `anthropic-version` 由网关设定且覆盖客户端同名头，防止伪造旧版本号降级协议。
 */

/** 发给上游的 Anthropic API 版本；是协议版本而非用户偏好，故不做成配置。 */
export const ANTHROPIC_VERSION = "2023-06-01";

export const messagesSurface: ProtocolSurface = {
  id: "messages",
  clientPaths: ["/v1/messages", "/messages"],
  upstreamPath: "/messages",
  // 流式与非流式都常用，不能收紧成 "sse"。
  streaming: "optional",
  // Anthropic SDK 用 `x-api-key` 发凭证;它在 `headers.ts` 里被剥掉,不会到上游。
  acceptsApiKeyHeader: true,

  extractModel: readModelField,
  wantsStream: readStreamField,

  /** 协议无状态、无链式指针；亲和只能靠 `x-opencode-session` 头。 */
  sessionKeyFrom(): string | undefined {
    return undefined;
  },

  responseIdFrom(): string | null {
    return null;
  },

  /** 见文件头：`x-api-key` 镜像是本面能工作的前提。 */
  extraUpstreamHeaders(ctx: UpstreamHeaderCtx): Record<string, string> {
    const out: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
    // 匿名 Worker 的空 key 不镜像成空头：空值与缺头在上游不一定等价。
    if (ctx.apiKey.trim() !== "") out["x-api-key"] = ctx.apiKey;
    return out;
  },

  /**
   * 非流式在顶层 `usage`；流式拆在 `message_start`（message.usage，含输入 token）
   * 与 `message_delta`（usage）两个事件，由 `createUsageCollector` 逐字段取大合并。
   */
  parseUsage(payload: unknown): TokenUsage | null {
    if (!isRecord(payload)) return null;
    const direct = readUsage(payload["usage"]);
    if (direct !== null) return direct;
    const message = payload["message"];
    if (!isRecord(message)) return null;
    return readUsage(message["usage"]);
  },
};
