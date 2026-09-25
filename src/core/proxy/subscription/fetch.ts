/**
 * 订阅拉取 —— 多 UA 协商。
 *
 * 解析在 `parse.ts`（纯函数）；这里只负责"把文本拿回来"，并处理一件
 * 只在真实网络上才存在的麻烦：**同一个 URL 会因 `User-Agent` 不同而返回
 * 不同格式**。机场普遍按 UA 分发：给 `clash` 返 YAML，给 `v2rayN` 返
 * base64 链接列表，给未知 UA 可能返一个 HTML 页面或直接 403。
 *
 * ## 为什么要"协商"而不是固定一个 UA
 *
 * 固定 `clash` 的话，只支持 v2ray 格式的订阅会永久失败，而错误信息是
 * "解不出节点" —— 用户无从知道换个 UA 就好了。所以依次尝试，取最好的结果。
 *
 * ## 顺序与提前退出：这是一个超时预算问题
 *
 * 朴素的做法是试 8 个 UA、每个超时 45 秒 —— **最坏情况 6 分钟**，而它是被
 * HTTP 请求同步等待的。本实现三处不同：
 *
 * 1. **单次超时 15 秒**，且有**总预算 40 秒**。超预算就停，返回已有的最好结果
 *    （而不是继续试完）。一个订阅拉不动时，用户要的是"快点告诉我失败了"。
 * 2. **命中即停**：拿到结构化格式（Clash/SIP008）且节点数 ≥1 就不再试 ——
 *    那已经是最好的形态，继续试只是浪费时间。
 * 3. **UA 列表按命中率排序**，`clash` 系在前。
 *
 * ## 安全
 *
 * - 订阅 URL 自带 token。所有错误消息里的 URL 必须过 `redactUrl`，
 *   且**绝不把响应体放进错误** —— 体里每一行都可能是凭证。
 * - 响应体有硬上限（8 MiB），边读边计数。只看 `content-length` 不够：
 *   那个头可以撒谎，也可以不给。
 * - **不跟随跨协议降级**：`https` → `http` 的重定向会让带 token 的 URL
 *   明文重发。`redirect: "follow"` 无法表达这个约束，所以手动跟随。
 */

import { redactUrl, safeErrorMessage } from "../../../shared/redact.ts";
import { parseSubscription, type ParseResult } from "./parse.ts";

/**
 * 候选 UA，按实测命中率排序。
 *
 * 前三个覆盖绝大多数机场的 Clash 分发；`v2rayN` 拿 base64 列表；
 * 最后放本项目自己的 UA —— 它几乎不会命中特殊分发，但如果订阅方
 * 只认"未知客户端"（有些自建的会返回通用格式），它是最后的兜底。
 */
export const SUBSCRIPTION_USER_AGENTS = [
  "clash",
  "ClashMeta/1.18.0",
  "clash-verge/2.5.2",
  "v2rayN/6.45",
  "zen-gateway/0.1",
] as const;

/** 响应体上限。一个 79 节点的订阅约 60 KB，8 MiB 是四个数量级的余量。 */
export const MAX_SUBSCRIPTION_BYTES = 8 * 1024 * 1024;

/** 单次请求超时。 */
const PER_ATTEMPT_TIMEOUT_MS = 15_000;

/** 整个协商过程的总预算 —— 见文件头。 */
const TOTAL_BUDGET_MS = 40_000;

/** 手动跟随重定向的上限。 */
const MAX_REDIRECTS = 5;

/**
 * 失败分类。
 *
 * 只存**分类**不存原文（`Subscription.lastErrorKind` 的 schema 就是这么定的）
 * —— 上游的错误正文可能回显 URL 里的 token。四类的下一步完全不同，
 * 这正是分类存在的理由。
 */
export type FetchFailureKind =
  /** 网络层失败（DNS、连接、TLS）。 */
  | "unreachable"
  /** HTTP 非 2xx。 */
  | "http_error"
  /** 超时（单次或总预算）。 */
  | "timeout"
  /** 体积超限。 */
  | "too_large"
  /** 拉到了但一个节点都解不出。 */
  | "unparseable";

export type FetchOk = {
  readonly ok: true;
  readonly result: ParseResult;
  /** 最终采用的是哪个 UA —— 写进日志，方便下次排查"为什么格式变了"。 */
  readonly userAgent: string;
  readonly bytes: number;
};

export type FetchErr = {
  readonly ok: false;
  readonly kind: FetchFailureKind;
  /** 已脱敏的可读原因。**不含**响应体，URL 已过 redactUrl。 */
  readonly reason: string;
};

export type FetchOutcome = FetchOk | FetchErr;

export type FetchDeps = {
  /** 注入以便测试。 */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** 只试这一个 UA（用户在界面上显式指定时）。 */
  readonly userAgent?: string;
};

/** 读体，边读边计数 —— `content-length` 可以撒谎或缺席。 */
async function readBounded(res: Response): Promise<{ text: string; bytes: number }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBSCRIPTION_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new SubscriptionTooLarge();
  }

  const reader = res.body?.getReader();
  if (reader === undefined) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_SUBSCRIPTION_BYTES) throw new SubscriptionTooLarge();
    return { text: buf.toString("utf8"), bytes: buf.byteLength };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > MAX_SUBSCRIPTION_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SubscriptionTooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks, size).toString("utf8"), bytes: size };
}

class SubscriptionTooLarge extends Error {
  constructor() {
    super("订阅响应超过上限");
  }
}

/**
 * 一次请求（含手动跟随重定向）。
 *
 * 手动跟随是为了守住"不降级到 http"这一条：订阅 URL 自带 token，
 * 一次 https→http 的重定向会让它明文出现在网络上。
 */
async function attempt(
  url: string,
  userAgent: string,
  deps: Required<Pick<FetchDeps, "fetchImpl">>,
  signal: AbortSignal,
): Promise<{ text: string; bytes: number }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await deps.fetchImpl(current, {
      method: "GET",
      signal,
      redirect: "manual",
      headers: {
        "user-agent": userAgent,
        accept: "*/*",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (location === null || location === "") {
        throw new Error(`HTTP ${res.status} 但没有 Location`);
      }
      const next = new URL(location, current);
      if (new URL(current).protocol === "https:" && next.protocol !== "https:") {
        // 订阅 URL 是凭证 —— 绝不跟着降级到明文。
        throw new Error("重定向要求从 https 降级到 http，已拒绝（订阅 URL 含 token）");
      }
      current = next.href;
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(res.status);
    }

    return await readBounded(res);
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** 这个结果比那个好吗？结构化格式优先，然后比节点数。 */
function better(a: ParseResult, b: ParseResult | null): boolean {
  if (b === null) return true;
  const score = (r: ParseResult) => r.nodes.length * 10 + (r.format === "clash" ? 5 : 0);
  return score(a) > score(b);
}

/**
 * 拉取并解析一个订阅。
 *
 * **不抛错** —— 返回 `FetchOutcome`。订阅拉取失败是**预期内**的常态
 * （机场挂了、token 过期、网络不通），把它做成异常会让每个调用点都要
 * try/catch，而那种代码里最容易漏掉脱敏。
 */
export async function fetchSubscription(url: string, deps: FetchDeps = {}): Promise<FetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const agents = deps.userAgent === undefined ? [...SUBSCRIPTION_USER_AGENTS] : [deps.userAgent];

  const startedAt = now();
  let best: { result: ParseResult; userAgent: string; bytes: number } | null = null;
  let lastKind: FetchFailureKind = "unreachable";
  let lastReason = "未尝试";
  let anyResponse = false;

  for (const userAgent of agents) {
    // 总预算 —— 见文件头。超了就用手上已有的最好结果。
    if (now() - startedAt >= TOTAL_BUDGET_MS) {
      if (best === null) {
        lastKind = "timeout";
        lastReason = `拉取 ${redactUrl(url)} 超过总预算 ${TOTAL_BUDGET_MS}ms`;
      }
      break;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);
    try {
      const { text, bytes } = await attempt(url, userAgent, { fetchImpl }, controller.signal);
      anyResponse = true;
      const parsed = parseSubscription(text);
      if (better(parsed, best?.result ?? null)) best = { result: parsed, userAgent, bytes };

      // 命中即停：结构化格式且有节点，已经是最好的形态。
      if (parsed.nodes.length > 0 && parsed.format !== "uri-list") break;
    } catch (err) {
      if (err instanceof SubscriptionTooLarge) {
        lastKind = "too_large";
        lastReason = `订阅响应超过 ${MAX_SUBSCRIPTION_BYTES} 字节上限`;
        // 体积超限不是 UA 的问题，换 UA 也一样 —— 直接停。
        break;
      }
      if (err instanceof HttpError) {
        anyResponse = true;
        lastKind = "http_error";
        lastReason = `${redactUrl(url)} 返回 HTTP ${err.status}`;
      } else if (controller.signal.aborted) {
        lastKind = "timeout";
        lastReason = `拉取 ${redactUrl(url)} 超时（${PER_ATTEMPT_TIMEOUT_MS}ms）`;
      } else {
        lastKind = "unreachable";
        // safeErrorMessage 会跟 cause 链并逐层脱敏 —— undici 把真实原因藏在 cause 里。
        lastReason = `拉取 ${redactUrl(url)} 失败：${safeErrorMessage(err)}`;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (best !== null && best.result.nodes.length > 0) {
    return { ok: true, result: best.result, userAgent: best.userAgent, bytes: best.bytes };
  }

  /*
   * 拉到了但解不出 —— 与"拉不到"必须分开报。
   *
   * 前者的下一步是"看看订阅是不是换格式了/token 过期返回了一个 HTML 页面"，
   * 后者是"检查网络与 URL"。合成一句"订阅失败"会让用户从头猜。
   */
  if (anyResponse && best !== null) {
    return {
      ok: false,
      kind: "unparseable",
      reason: `${redactUrl(url)} 有响应但解不出任何节点（试过 ${agents.length} 个 UA）`,
    };
  }

  return { ok: false, kind: lastKind, reason: lastReason };
}
