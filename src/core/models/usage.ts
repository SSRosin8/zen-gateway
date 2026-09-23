/**
 * 上游报告的 token 用量 —— `ProtocolSurface.parseUsage` 的共享底座。
 *
 * ## 为什么 Phase 6 就得有它
 *
 * 规划的 `ProtocolSurface` 列了 `parseUsage`，而它先前**全仓不存在**。
 * Phase 7 的门槛直接依赖它（per-model token、缓存命中率、usage 覆盖率），
 * 而每新增一个协议面都要实现一次 —— 面越多，补这个成员的改动越大。
 * 所以它必须跟新增两个面同一轮落地，而不是等到需要它的那一轮。
 *
 * ## 分工：**信封**由面决定，**字段名**在这里统一
 *
 * 三个面真正不同的是 usage 对象**藏在哪**：
 *
 * | 面 | 非流式 | 流式事件 |
 * |---|---|---|
 * | chat | `usage` | `usage`（末帧） |
 * | responses | `usage` | `response.usage` |
 * | messages | `usage` | `message.usage`（`message_start`）+ `usage`（`message_delta`） |
 *
 * 各面的 `parseUsage` 只负责走到那个对象，剩下的交给本文件。
 *
 * 切分的好处是"面接错了"这种接线错误**在嵌套信封上**可被测试查出来：
 * chat 不认 `{response:{usage}}` 也不认 `{message:{usage}}`，responses 不认
 * `{message:{usage}}`，messages 不认 `{response:{usage}}`。
 *
 * 但要说清它**不**能查出什么：三个面都认顶层 `usage`（那是各自非流式响应的
 * 形状），所以拿 chat 的非流式载荷喂 responses 的 `parseUsage` 会照常出数。
 * 写下这条是因为"每个面只认自己的信封"听起来更漂亮，而它是假的 ——
 * 一个假的强保证比一个真的弱保证更危险，下一轮会有人依赖它。
 *
 * 字段名反过来必须宽：`prompt_tokens`（OpenAI）与 `input_tokens`（Responses／
 * Anthropic）指的是同一件事，而免费额度闸门让我**无法实测**Zen 在每个面上
 * 究竟用哪套（请求根本到不了模型）。宽着读的代价是多认几个键，收紧的代价是
 * 静默丢掉真实用量。
 *
 * ## 跨事件合并只有一个函数，不按面分
 *
 * Anthropic 面的用量**拆在两个事件里**：`message_start` 带输入 token，
 * `message_delta` 带输出 token。旧项目为此写了第二个 SSE 解析器
 * （`parseAnthropicUsageFromSseBuffer`），但那是因为它在"扫整个缓冲区"
 * 那一层做合并。改成"逐事件解析 + 逐字段取大"之后，两类形态是同一套逻辑：
 * OpenAI 那种"只有末帧带完整 usage"的情况下，逐字段取大的结果**就是**末帧。
 */

export type TokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** 命中提示缓存的 token。 */
  readonly cacheReadTokens: number;
  /** 写入提示缓存的 token。 */
  readonly cacheWriteTokens: number;
  /**
   * 明确未命中缓存的输入 token。
   *
   * 不由 `prompt - cacheRead` 推算：有缓存写入时那个减法不成立。
   * 只有上游显式报了才记（DeepSeek 系列会报）。
   */
  readonly cacheMissTokens: number;
};

/**
 * 非负整数。
 *
 * 只认数字与**数字字符串**，不认布尔 —— 旧项目那版用
 * `typeof v === "number" ? v : Number(v)`，于是 `true` 被算成 1 个 token。
 * 数字字符串要认：JSON 里 token 数本该是数字，但上游若哪天改成字符串，
 * 强行丢弃会让统计静默归零，而 `Number("123")` 是无歧义的。
 */
function tokenCount(value: unknown): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    n = Number(value);
  } else {
    return 0;
  }
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 从一个 **usage 对象**读出用量。入参是信封里的那一层，不是整个响应。
 *
 * 取 `Math.max` 而不是 `??`：两套命名同时出现时结果不该取决于我写的顺序，
 * 而 `??` 遇到显式的 `0` 会停在 0 上（`{prompt_tokens:0, input_tokens:812}`
 * 会被读成 0）。
 *
 * 全为 0 时返回 null —— 「上游没报用量」与「这次真的用了 0 个 token」必须
 * 区分开。返回一个全零对象会让 Phase 7 记下一行看起来有数据的空记录，
 * 于是 usage 覆盖率这个指标永远是 100%，而它存在的意义正是发现没覆盖到的面。
 */
export function readUsage(usage: unknown): TokenUsage | null {
  const u = asRecord(usage);
  if (u === null) return null;

  const promptDetails = asRecord(u["prompt_tokens_details"]) ?? {};
  const inputDetails = asRecord(u["input_tokens_details"]) ?? {};

  const promptTokens = Math.max(tokenCount(u["prompt_tokens"]), tokenCount(u["input_tokens"]));
  const completionTokens = Math.max(
    tokenCount(u["completion_tokens"]),
    tokenCount(u["output_tokens"]),
  );
  const cacheReadTokens = Math.max(
    tokenCount(u["cache_read_input_tokens"]),
    tokenCount(u["prompt_cache_hit_tokens"]),
    tokenCount(u["cache_read_tokens"]),
    tokenCount(promptDetails["cached_tokens"]),
    tokenCount(inputDetails["cached_tokens"]),
  );
  const cacheWriteTokens = Math.max(
    tokenCount(u["cache_creation_input_tokens"]),
    tokenCount(u["cache_write_tokens"]),
    tokenCount(u["prompt_cache_write_tokens"]),
    tokenCount(promptDetails["cache_creation_tokens"]),
  );
  const cacheMissTokens = tokenCount(u["prompt_cache_miss_tokens"]);

  // 上游没报 total 时自己算 —— Anthropic 面就不报。
  const reportedTotal = tokenCount(u["total_tokens"]);
  const totalTokens = Math.max(reportedTotal, promptTokens + completionTokens);

  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    totalTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    cacheMissTokens === 0
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
  };
}

/**
 * 逐字段取大地合并两次读数。
 *
 * 用途是把一条流里多个事件的用量累起来。`totalTokens` **重算**而不是取大：
 * 它可能是我们自己由 prompt+completion 推出来的，两个事件各自推出的半个总数
 * 取大会小于真实总数（`message_start` 推出 812、`message_delta` 推出 37，
 * 取大得 812，而真实是 849）。
 */
export function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  const promptTokens = Math.max(a.promptTokens, b.promptTokens);
  const completionTokens = Math.max(a.completionTokens, b.completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(a.totalTokens, b.totalTokens, promptTokens + completionTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    cacheMissTokens: Math.max(a.cacheMissTokens, b.cacheMissTokens),
  };
}

/* ------------------------------------------------------------------ *
 * 从响应流里收集用量
 * ------------------------------------------------------------------ */

/**
 * 非流式响应最多累积这么多文本用于解析。
 *
 * 非流式的 chat/responses/messages 响应是一个 JSON 对象,实测量级是几 KB。
 * 设这个上限是因为「非流式」只是客户端**没要求**流式,上游给多大我们不控制;
 * 而累积一份无界副本会让一个大响应把内存翻倍 —— 那与原样透传的初衷冲突。
 * 超限的后果只是这次拿不到用量,不影响转发。
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * 一行 SSE `data:` 最长认这么多。超长的单行不尝试解析。
 *
 * 防的是"上游发一个没有换行的巨大流"这种形态 —— 那会让待解析行无界增长。
 */
const MAX_LINE_LENGTH = 512 * 1024;

/**
 * 增量收集用量。
 *
 * ## 为什么必须增量,不能缓冲整条流
 *
 * 三条约束同时成立,而它们排除了所有"先存起来再解析"的做法:
 *
 * 1. **用量在流的哪一端不确定。** Anthropic 面把它**拆在两头**:
 *    `message_start` 带输入 token,`message_delta` 带输出 token。所以
 *    「只留尾部窗口」会丢掉输入 token,「只扫开头」会丢掉输出 token。
 * 2. **不能缓冲整条流。** 多模态响应可以很大,而 `tap.ts` 存在的全部理由
 *    就是不把响应憋在网关里。
 * 3. **`tap` 的扫描预算只覆盖开头 1 MiB**,而失效推理的扫描器正需要那样
 *    (拒绝消息若存在必在开头)。用量不能共用那个预算。
 *
 * 增量解析同时满足三条:状态只有「一行未读完的文本」与「已合并的用量」,
 * 两者都有界,而覆盖范围是**整条流**。
 *
 * ## 只解析含 `usage` 的行
 *
 * 一条长 SSE 有几千个 delta 事件,逐个 `JSON.parse` 是真实开销。而用量事件
 * 必然含 `usage` 这个键名,于是一次子串检查就能把绝大多数行排除掉 ——
 * 剩下的才解析。子串命中但解析不出用量的行会被 `parse` 返回 null 挡掉,
 * 所以这个优化不改变结果,只改变代价。
 *
 * @param parse 面自己的信封解析(`surface.parseUsage`)。
 */
export function createUsageCollector(parse: (payload: unknown) => TokenUsage | null): {
  feed: (text: string) => void;
  usage: () => TokenUsage | null;
} {
  let pending = "";
  let buffered = "";
  let merged: TokenUsage | null = null;
  /** 见过 `data:` 行 —— 据此判定这是 SSE 而非单个 JSON 响应。 */
  let sawEvent = false;

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    sawEvent = true;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    // 见函数注释:不含 usage 的行不值得解析。
    if (!data.includes("usage")) return;
    try {
      merged = mergeUsage(merged, parse(JSON.parse(data)));
    } catch {
      /* 上游发了个解析不了的事件 —— 不影响转发,也不影响其他事件 */
    }
  };

  return {
    feed(text: string): void {
      /*
       * 非流式那一路同时累积一份副本。
       *
       * 必须两路都做而不是二选一:`feed` 被调用时还不知道这是 SSE 还是
       * 单个 JSON —— 客户端发了 `stream: true` 上游也可能以非流式响应,
       * 而上游的 content-type 在这一层拿不到。有界累积的代价可控,
       * 而"猜错了就完全拿不到用量"的代价是一整类面的统计为空。
       */
      if (!sawEvent && buffered.length < MAX_BUFFERED_BYTES) {
        buffered += text;
      }

      pending += text;
      for (;;) {
        const at = pending.indexOf("\n");
        if (at === -1) break;
        consumeLine(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      /*
       * 一行长到离谱就丢掉它。
       *
       * 不能无条件留着等换行:那让 `pending` 随流无界增长,
       * 而这正是"不缓冲整条流"要避免的事。
       */
      if (pending.length > MAX_LINE_LENGTH) pending = "";
    },

    usage(): TokenUsage | null {
      // 最后一行可能没有结尾换行 —— SSE 的末帧常常如此。
      if (pending !== "") {
        consumeLine(pending);
        pending = "";
      }
      if (merged !== null) return merged;

      /*
       * 没有任何 `data:` 事件 → 这是一个完整的 JSON 响应体。
       *
       * 只在没拿到 SSE 用量时才试,因为 SSE 那一路更可靠:
       * 累积副本可能因超限而被截断,而截断的 JSON 解析不出来。
       */
      if (sawEvent || buffered === "") return null;
      try {
        return parse(JSON.parse(buffered));
      } catch {
        return null;
      }
    },
  };
}

/** 供日志与诊断:一行紧凑描述,不含任何响应内容。 */
export function describeUsage(usage: TokenUsage): string {
  const parts = [`in=${usage.promptTokens}`, `out=${usage.completionTokens}`, `total=${usage.totalTokens}`];
  if (usage.cacheReadTokens > 0) parts.push(`cacheRead=${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens > 0) parts.push(`cacheWrite=${usage.cacheWriteTokens}`);
  if (usage.cacheMissTokens > 0) parts.push(`cacheMiss=${usage.cacheMissTokens}`);
  return parts.join(" ");
}
