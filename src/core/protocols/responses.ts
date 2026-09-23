import type { ProtocolSurface } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

/**
 * OpenAI Responses 面。
 *
 * ## 这个面带来的唯一结构性新东西:**体内会话指针**
 *
 * `previous_response_id` 是协议**自己**的会话语义,而其余两个面都只能靠
 * `x-opencode-session` 头。这让 `sessionHashFrom` 的「体内优先于头」那条接线
 * 第一次真的可执行 —— 在只有 chat 面的时候它**结构上无法执行**
 * (`chatSurface.sessionKeyFrom` 恒返回 `undefined`,且它是唯一注册的面),
 * 第五轮审核把这种情况归为「调用点存在但输入集为空」,当时只能用假面补测。
 * 现在那个假面有了对应的真实现。
 *
 * ## 体内指针优先于头,理由与先前写的一致
 *
 * 客户端可以在同一个 `x-opencode-session` 里发起互不相关的多条 response 链,
 * 也可以跨 session 续同一条链。`previous_response_id` 说的是**这次要接哪个
 * 响应**,那比客户端的会话标签更接近"上游侧的推理块归谁签发"这个真问题。
 */

/** 上游对本面的鉴权只需 Bearer —— 实测免 key 时带坏 key 即抵达免费闸门(403)。 */
export const responsesSurface: ProtocolSurface = {
  id: "responses",
  clientPaths: ["/v1/responses", "/responses"],
  upstreamPath: "/responses",
  /*
   * 两者都支持。
   *
   * 刻意**不**写成 `"sse"`:那会被 relay 理解为"必须流式"吗?——不会
   * (relay 只拦 `"none"` 面收到流式请求),但 `"sse"` 在语义上声称本面只产生
   * SSE,而 Responses 的非流式响应是一个完整 JSON 对象。写准比写严要紧。
   */
  streaming: "optional",

  extractModel: readModelField,
  wantsStream: readStreamField,

  /**
   * 体内会话指针。
   *
   * 只认非空字符串:`previous_response_id: null` 是"这是一条新链"的合法表达,
   * 把它当成会话键会让所有新链共享同一个绑定。
   *
   * 不做长度检查 —— 那是 `normalizeSessionKey` 的职责(它对超长键**拒绝**
   * 而不是截断,因为截断会让前缀相同的两条会话真碰撞)。这里只负责取字段。
   */
  sessionKeyFrom(body: unknown): string | undefined {
    if (!isRecord(body)) return undefined;
    const id = body["previous_response_id"];
    if (typeof id !== "string" || id === "") return undefined;
    return id;
  },

  /** 本面无特有头;鉴权与 OpenCode 身份头由 upstream/headers.ts 统一加。 */
  extraUpstreamHeaders(): Record<string, string> {
    return {};
  },

  /**
   * 用量信封:非流式在顶层 `usage`,流式事件在 `response.usage`。
   *
   * 流式的 `response.completed` 事件把整个 response 对象包了一层,
   * 所以两处都要看。顺序无关 —— 一个载荷不会同时是两种形态。
   */
  parseUsage(payload: unknown): TokenUsage | null {
    if (!isRecord(payload)) return null;
    const direct = readUsage(payload["usage"]);
    if (direct !== null) return direct;
    const response = payload["response"];
    if (!isRecord(response)) return null;
    return readUsage(response["usage"]);
  },
};
