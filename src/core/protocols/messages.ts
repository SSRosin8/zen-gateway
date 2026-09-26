import type { ProtocolSurface, UpstreamHeaderCtx } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

/**
 * Anthropic Messages 面。
 *
 * ## 这个面必须把 key **镜像**到 `x-api-key`,否则整池 Worker 会被冷却
 *
 * 这是实测出来的最要紧一条(2026-09-23,先免 key 再用真实 key 在
 * **免费模型**上复验,各两次):
 *
 * | 发给 `/zen/v1/messages` 的凭证头 | 状态 |
 * |---|---|
 * | 仅 `Authorization: Bearer <key>` | **500** `Internal server error` |
 * | 仅 `x-api-key: <key>` | 403 `FreeTierError` |
 * | 两者都带 | 403 `FreeTierError` |
 *
 * 403 `FreeTierError` 说明请求**已经走到免费额度闸门**(即凭证被识别了),
 * 而 500 说明它在那之前就崩了 —— 上游这个面从 `x-api-key` 读凭证,缺了就炸。
 * 另两个面都只认 Bearer,所以这是 Messages 面**独有**的要求。
 *
 * **为什么这条不修就很糟**:500 经 `classifyStatus` 归为 `upstream_error` →
 * `isRetryable` 为真且**归咎于 Worker** → 重试链把每个 Worker 依次试一遍,
 * 每个都记一次失败并进指数退避。于是**一个正确配置的网关,只要客户端用了
 * Messages 面,就会把整池 Worker 打进冷却**,而症状是"上游好像挂了",
 * 完全指不到真实原因(少了一个头)。不变量 #4 要保的正是这件事,
 * 而这里破坏它的不是客户端的坏请求,是我们自己少发了一个头。
 *
 * 独立印证:**这个要求不是本项目的特例**：任何驱动 Zen Messages 面的客户端都同样
 * **顺带把 Bearer key 镜像成 `x-api-key`**。两处从不同入口撞到同一个要求。
 *
 * ## 为什么这件事非得由**面**来做
 *
 * `headers.ts` 把 `x-api-key` 列进 `STRIPPED_HEADERS`(客户端发来的凭证头
 * 一律剥掉),而这是对的:客户端侧那个 `x-api-key` 与上游凭证无关。
 * 所以镜像只能由**知道自己需要它**的那一层加,也就是本面的
 * `extraUpstreamHeaders` —— 而它拿得到 `ctx.apiKey` 正是为此。
 *
 * 这也是 `UpstreamHeaderCtx.apiKey` 唯一的读者(chat 面返回 `{}`)。没有这里,
 * 它就是"代码里有死信息"。
 *
 * ## `anthropic-version` 由网关设定,绝不取自客户端
 *
 * 实测它对结果**没有影响**(带与不带都是同样的状态码),但 Anthropic 协议
 * 本身要求它,而上游哪天开始校验时我们不该是"恰好没发"的那一方。
 *
 * 值必须由网关给:若取自客户端头,一个伪造的旧版本号就成了协议降级原语。
 * `headers.ts` 的第 3 步(面特有头)在第 1 步(客户端透传)**之后**,
 * 所以这里写的值会盖掉客户端发来的同名头 —— 顺序在那边有注释钉着。
 */

/**
 * 发给上游的 Anthropic API 版本。
 *
 * 写成常量而不是配置项:这是**协议**版本,不是用户偏好。做成可配的只会
 * 多一个能配错的地方,而配错的症状是上游按另一个版本解释请求体。
 */
export const ANTHROPIC_VERSION = "2023-06-01";

export const messagesSurface: ProtocolSurface = {
  id: "messages",
  clientPaths: ["/v1/messages", "/messages"],
  upstreamPath: "/messages",
  /*
   * 两者都支持,所以是 `"optional"` 而不是 `"sse"`。
   *
   * 这一条有测试反向钉着:把它收紧成"必须流式"会拒掉合法的非流式请求,
   * 而 Messages 客户端两种都常用。
   */
  streaming: "optional",
  // Anthropic SDK 用 `x-api-key` 发凭证;它在 `headers.ts` 里被剥掉,不会到上游。
  acceptsApiKeyHeader: true,

  extractModel: readModelField,
  wantsStream: readStreamField,

  /**
   * 本面的请求体里没有会话标识。
   *
   * Anthropic Messages 是无状态的 —— 整个对话每次都完整重发,
   * 没有 `previous_response_id` 那样的链式指针。所以亲和只能靠
   * `x-opencode-session` 头,与 chat 面相同。
   */
  sessionKeyFrom(): string | undefined {
    return undefined;
  },

  responseIdFrom(): string | null {
    return null;
  },

  /** 见文件头:`x-api-key` 镜像是本面**能工作的前提**,不是可选优化。 */
  extraUpstreamHeaders(ctx: UpstreamHeaderCtx): Record<string, string> {
    const out: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
    /*
     * 空 key 不镜像一个空头。
     *
     * `x-api-key: ` (空值)与"没有这个头"在上游侧不一定等价,而免 key 的
     * 匿名 Worker 可以进入转发候选链，但它应保持没有这个头。
     * 目录查询那条路径会用空 key,但它不走本面。
     */
    if (ctx.apiKey.trim() !== "") out["x-api-key"] = ctx.apiKey;
    return out;
  },

  /**
   * 用量信封:非流式在顶层 `usage`,流式**拆在两个事件里**。
   *
   * 这是三个面里唯一需要跨事件合并的:
   *
   * - `message_start` → `{ message: { usage: { input_tokens, ... } } }`
   * - `message_delta` → `{ usage: { output_tokens } }`
   *
   * 所以两处都要看,而累加由 `createUsageCollector` 的逐字段取大完成 ——
   * 「只留流的尾部窗口」那种做法会丢掉输入 token,因为它在流的**开头**。
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
