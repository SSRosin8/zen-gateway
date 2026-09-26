/**
 * 订阅拉取与多 UA 协商。机场按 `User-Agent` 分发不同格式(YAML、base64 列表、HTML/403),
 * 固定一个 UA 会让部分订阅永久「解不出节点」,所以依次尝试取最好结果。
 * 单次超时 15 秒、总预算 40 秒,拿到结构化格式且有节点即停;UA 按命中率排序。
 *
 * 安全:错误里的 URL 过 `redactUrl`,绝不放响应体;响应体 8 MiB 硬上限边读边计数;
 * 手动跟随重定向,拒绝 https → http 降级(订阅 URL 含 token)。
 */

import { redactUrl, safeErrorMessage } from "../../../shared/redact.ts";
import { parseSubscription, type ParseResult } from "./parse.ts";

/** 候选 UA,按命中率排序;最后是本项目自己的 UA 作兜底。 */
export const SUBSCRIPTION_USER_AGENTS = [
  "clash",
  "ClashMeta/1.18.0",
  "clash-verge/2.5.2",
  "v2rayN/6.45",
  "zen-gateway/0.1",
] as const;

/** 响应体上限。 */
export const MAX_SUBSCRIPTION_BYTES = 8 * 1024 * 1024;

/** 单次请求超时。 */
const PER_ATTEMPT_TIMEOUT_MS = 15_000;

/** 整个协商过程的总预算。 */
const TOTAL_BUDGET_MS = 40_000;

/** 手动跟随重定向的上限。 */
const MAX_REDIRECTS = 5;

/**
 * 失败分类。只存分类不存原文(上游错误正文可能回显 URL 里的 token)。
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
  /** 最终采用的 UA,写进日志便于排查格式变化。 */
  readonly userAgent: string;
  readonly bytes: number;
};

export type FetchErr = {
  readonly ok: false;
  readonly kind: FetchFailureKind;
  /** 已脱敏的可读原因,不含响应体。 */
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

/** 读体并边读边计数:`content-length` 可以撒谎或缺席。 */
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

/** 一次请求,手动跟随重定向以拒绝降级到 http。 */
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
 * 拉取并解析一个订阅。不抛错,返回 `FetchOutcome`:失败是常态,做成异常会让每个调用点
 * 都要 try/catch,最容易漏掉脱敏。
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
    // 超出总预算就用手上已有的最好结果。
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

      if (parsed.nodes.length > 0 && parsed.format !== "uri-list") break;
    } catch (err) {
      if (err instanceof SubscriptionTooLarge) {
        lastKind = "too_large";
        lastReason = `订阅响应超过 ${MAX_SUBSCRIPTION_BYTES} 字节上限`;
        // 换 UA 也一样,直接停。
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
        // safeErrorMessage 跟 cause 链逐层脱敏:undici 把真实原因藏在 cause 里。
        lastReason = `拉取 ${redactUrl(url)} 失败：${safeErrorMessage(err)}`;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (best !== null && best.result.nodes.length > 0) {
    return { ok: true, result: best.result, userAgent: best.userAgent, bytes: best.bytes };
  }

  // 拉到了但解不出与拉不到必须分开报:下一步排查方向不同。
  if (anyResponse && best !== null) {
    return {
      ok: false,
      kind: "unparseable",
      reason: `${redactUrl(url)} 有响应但解不出任何节点（试过 ${agents.length} 个 UA）`,
    };
  }

  return { ok: false, kind: lastKind, reason: lastReason };
}
