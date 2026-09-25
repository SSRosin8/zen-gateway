import type { ProtocolSurface } from "./types.ts";
import { isRecord, readModelField, readStreamField } from "./types.ts";
import { readUsage, type TokenUsage } from "../models/usage.ts";

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

  /**
   * 用量信封:本面**只在顶层** `usage`,两种形态都一样。
   *
   * 流式时它出现在末帧(`stream_options.include_usage` 那条约定),
   * 非流式时就是响应体的顶层字段 —— 所以不需要看任何嵌套层。
   *
   * 刻意**不**顺手认 `response.usage` 或 `message.usage`:那是另两个面的
   * 信封,而一个"什么都认"的解析会让接错面这种错误不产生任何症状,
   * 只是统计数字静默变错。
   */
  parseUsage(payload: unknown): TokenUsage | null {
    if (!isRecord(payload)) return null;
    return readUsage(payload["usage"]);
  },
};

/**
 * `/v1/models` 不是协议面,而是网关自己回答的目录查询。
 *
 * 放在这里只为集中定义路径常量,避免 routes 与测试各写一份字符串。
 */
export const MODELS_PATHS = ["/v1/models", "/models"] as const;

/*
 * 这里先前有一个 `looksLikeChatBody(body)` —— 注释写着「用于 400 早退」，
 * 而**全仓零引用**（连测试都没有）。第九轮建了那道关卡之后删掉它。
 *
 * 为什么是删而不是留着加白名单：它声称的职责已经由 `relay.ts` 第 2 步
 * （解析副本 + 免费判定）实际承担了，而一个"看起来该用却没人用"的校验函数
 * 是个陷阱 —— 下一个人会以为请求体形状已经被它挡过一道。
 *
 * 真要加"形状早退"的话，那是协议面接口上的一个能力位（像 `streaming`），
 * 要在 `types.ts` 里声明并由 `relay.ts` 统一调用，而不是一个孤立的导出。
 */
