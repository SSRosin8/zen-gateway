import { isRecord } from "../protocols/types.ts";

/**
 * 上游报告的 token 用量：`ProtocolSurface.parseUsage` 的共享底座。
 *
 * 信封（usage 藏在哪）由各面决定，字段名在这里统一且宽读：`prompt_tokens` 与
 * `input_tokens` 是同一件事，收紧的代价是静默丢掉真实用量。
 *
 * 局限：三个面都认顶层 `usage`，只有嵌套信封可区分接错面。例如 messages 面误接成
 * chat 会丢掉 `message_start` 的输入 token 而输出照常，得到算错而非缺失的数字。
 *
 * 跨事件合并只有一套逻辑（逐事件解析 + 逐字段取大），对「只有末帧带 usage」同样成立。
 */

export type TokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** 命中提示缓存的 token。 */
  readonly cacheReadTokens: number;
  /** 写入提示缓存的 token。 */
  readonly cacheWriteTokens: number;
  /** 上游显式报告的缓存未命中输入 token；不由 `prompt - cacheRead` 推算（有缓存写入时不成立）。 */
  readonly cacheMissTokens: number;
};

/**
 * 非负整数 token 数，读不出为 0。不认布尔（否则 `true` 算 1）；认十进制字符串，
 * 但不认 `0x`/`0b`/`1e5`（裸 `Number()` 会静默读成 16/7/100000）。上界见 `clampTokens`。
 */
function tokenCount(value: unknown): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) {
    n = Number(value);
  } else {
    return 0;
  }
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clampTokens(Math.floor(n));
}

/**
 * token 数上界，入口与所有求和出口共用（纪律 #4）：否则两个 1e308 相加得 Infinity，
 * 日志打出 `total=Infinity`、JSON 变成 null、写进 SQLite INTEGER 列。
 */
function clampTokens(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * 从信封里的 usage 对象读出用量。两套命名取 `Math.max` 而非 `??`：`??` 会停在显式的 0 上。
 * 全为 0 返回 null，区分「上游没报」与「用了 0 token」，否则 usage 覆盖率恒为 100%。
 */
export function readUsage(usage: unknown): TokenUsage | null {
  if (!isRecord(usage)) return null;
  const u = usage;

  const promptDetails = isRecord(u["prompt_tokens_details"]) ? u["prompt_tokens_details"] : {};
  const inputDetails = isRecord(u["input_tokens_details"]) ? u["input_tokens_details"] : {};

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

  // 上游没报 total 时自己算（Anthropic 面不报）。
  const reportedTotal = tokenCount(u["total_tokens"]);
  const totalTokens = clampTokens(Math.max(reportedTotal, promptTokens + completionTokens));

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
 * 逐字段取大合并一条流里多个事件的用量。`totalTokens` 重算而非取大：两个事件各自推出的
 * 半个总数取大会偏小（812 与 37 取大得 812，真实 849）。
 *
 * 前提是上游累计上报（三个已知面均如此）。新面接入时先确认累计还是增量；增量上报的面
 * 不能用本函数，需改为逐字段求和并保证同一事件不被 feed 两次。
 */
export function mergeUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  const promptTokens = Math.max(a.promptTokens, b.promptTokens);
  const completionTokens = Math.max(a.completionTokens, b.completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: clampTokens(Math.max(a.totalTokens, b.totalTokens, promptTokens + completionTokens)),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
    cacheMissTokens: Math.max(a.cacheMissTokens, b.cacheMissTokens),
  };
}

/** 非流式响应最多累积的解析副本；上游给多大不受控，超限只是拿不到用量，不影响转发。 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * 单个待解析行的上限，与 `MAX_BUFFERED_BYTES` 同量级：Responses 面的 `response.completed`
 * 内嵌整个 response 对象，是该面唯一带用量的事件；上限过小会让用量能否读到取决于上游分块位置。
 */
const MAX_LINE_LENGTH = MAX_BUFFERED_BYTES;

/**
 * 增量收集整条流的用量，状态有界。不能缓冲整条流（`tap.ts` 的初衷），也不能只看头或尾
 * （Anthropic 把输入/输出 token 拆在流的两头），且不能共用 tap 的开头 1 MiB 扫描预算。
 * 只解析含 `usage` 子串的行，这只省代价，不改结果。
 *
 * @param parse 面自己的信封解析(`surface.parseUsage`)。
 */
export function createUsageCollector(parse: (payload: unknown) => TokenUsage | null): {
  feed: (text: string) => void;
  usage: () => TokenUsage | null;
  /**
   * 我们自己丢过内容吗（超长行被弃、非流式累积超限）。必须与 `usage() === null`（上游没报）
   * 区分：越界可观测比调大常量更耐久。
   */
  dropped: () => boolean;
} {
  let pending = "";
  let buffered = "";
  let merged: TokenUsage | null = null;
  /** 见过 `data:` 行 —— 据此判定这是 SSE 而非单个 JSON 响应。 */
  let sawEvent = false;
  /** 见 `dropped()`。 */
  let droppedContent = false;

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    sawEvent = true;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    if (!data.includes("usage")) return;
    try {
      merged = mergeUsage(merged, parse(JSON.parse(data)));
    } catch {
      /* 解析不了的事件不影响转发与其他事件 */
    }
  };

  return {
    feed(text: string): void {
      // 两路同时做：feed 时还不知道上游回的是 SSE 还是单个 JSON（与客户端的 stream 无关）。
      if (!sawEvent && buffered.length < MAX_BUFFERED_BYTES) {
        buffered += text;
      } else if (!sawEvent) {
        droppedContent = true;
      }

      pending += text;
      for (;;) {
        const at = pending.indexOf("\n");
        if (at === -1) break;
        consumeLine(pending.slice(0, at));
        pending = pending.slice(at + 1);
      }
      // 超长行丢弃并留痕，否则 `pending` 随流无界增长。
      if (pending.length > MAX_LINE_LENGTH) {
        pending = "";
        droppedContent = true;
      }
    },

    usage(): TokenUsage | null {
      // SSE 末帧常常没有结尾换行。
      if (pending !== "") {
        consumeLine(pending);
        pending = "";
      }
      if (merged !== null) return merged;

      // 没有 `data:` 事件即完整 JSON 响应体；SSE 用量优先，因为累积副本可能被截断。
      if (sawEvent || buffered === "") return null;
      try {
        return parse(JSON.parse(buffered));
      } catch {
        return null;
      }
    },

    dropped(): boolean {
      return droppedContent;
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
