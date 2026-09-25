import type { ProtocolId } from "../../shared/schema.ts";
import type { TokenUsage } from "../models/usage.ts";

/**
 * 协议面接口 —— 新增一个客户端协议只需实现它并注册。
 *
 * ## 为什么没有 transformRequest
 *
 * 规划里曾设计 `transformRequest(ctx): unknown`,把客户端请求体改写成上游形状。
 * 实际不需要,而且有害:
 *
 * 1. Zen 为每个协议面提供**各自的原生端点**(`/chat/completions`、`/responses`、
 *    `/messages`),所以三个面都是「同形状换路径」,没有跨协议翻译的需求。
 * 2. 本项目定位是**原样透传**。改写请求体意味着 `JSON.parse` → `stringify`
 *    往返,而那**不是无损的**:实测 `{"n":1.0,"s":"你好"}` 往返后变成
 *    `{"n":1,"s":"你好"}` —— 字节数变了、数字字面量变了、转义形式变了。
 *    对一个「让 OpenCode 原样用上游」的网关,这是不该引入的差异。
 *
 * 因此本接口的方法**全部是只读**的:它们在请求体的一份**解析副本**上做判定,
 * 转发出去的始终是客户端发来的原始字节。真需要翻译时再加这个方法,
 * 现在加只会得到一个永不被执行的分支。
 *
 * ## 判定为何都接受 `unknown`
 *
 * 请求体来自客户端,任何形状都可能。把入参写成 `unknown` 而不是某个具体类型,
 * 实现里就**必须**逐层收窄 —— 否则 `body.model` 这种写法在 `any` 下能过编译,
 * 在运行期对 `null`/数组/字符串 body 抛 TypeError,把一个 400 变成 500。
 */
export type ProtocolSurface = {
  readonly id: ProtocolId;
  /** 客户端可用的路径,含兼容别名。注册时会检查跨面重复。 */
  readonly clientPaths: readonly string[];
  /** 上游路径,拼在 `gateway.baseUrl` 之后。 */
  readonly upstreamPath: string;
  /**
   * 该面的流式能力。`"none"` 为 jev 这类**非流式**面预留 ——
   * 上游文档说明它返回取值与概率而非生成文本,现有流式泵不适用。
   */
  readonly streaming: "sse" | "none" | "optional";

  /** 从请求体取模型 id;取不到返回 null(交由调用方报 400)。 */
  extractModel(body: unknown): string | null;
  /** 客户端是否要求流式。 */
  wantsStream(body: unknown): boolean;
  /**
   * 会话亲和键(Phase 5 用)。
   *
   * 只有 Responses 面有 `previous_response_id` 这类体内会话标识;
   * 其余面返回 undefined,由 header 里的 `x-opencode-session` 承担。
   */
  sessionKeyFrom(body: unknown): string | undefined;
  /** 从完整响应或 SSE 事件中读取可用于 Responses 续链的响应 id。 */
  responseIdFrom?(payload: unknown): string | null;
  /**
   * 该面特有的上游请求头。
   *
   * 通用头(鉴权、content-type、OpenCode 身份头)由 `upstream/headers.ts`
   * 统一处理,这里只放**面特有**的,例如 Anthropic 面的 `anthropic-version`。
   */
  extraUpstreamHeaders(ctx: UpstreamHeaderCtx): Record<string, string>;
  /**
   * 从上游响应载荷里取 token 用量。
   *
   * 入参是**一个已解析的 JSON 值** —— 非流式响应的整个体,或流式响应的
   * 单个 SSE 事件。两者都传给同一个方法,因为各面的 usage 信封在两种形态下
   * 只差一层嵌套,分成两个方法会让每个面多一处可以接错的地方。
   *
   * 取不到返回 null。**「没报用量」与「用了 0 个 token」必须区分开** ——
   * 返回全零对象会让 Phase 7 的 usage 覆盖率指标永远是 100%,
   * 而那个指标存在的意义正是发现没覆盖到的面。
   *
   * 字段名的归一化在 `core/models/usage.ts`,这里只负责走到 usage 对象。
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
 * 从请求体读取模型 id。
 *
 * 只接受**非空且无首尾空白**的字符串。不做大小写归一化或 trim ——
 * 这个值要参与免费模型放行判定,而判定必须可预测:一旦开始归一化,
 * 「该用哪种归一化」就会成为后续每个面都要重新决定的问题,
 * 而任何两处不一致都是一个放行漏洞。上游 id 本身就是规范小写,
 * 客户端发 `Big-Pickle` 被拒是正确结果(那个 id 确实不存在)。
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
