import type { CooldownConfig } from "../../shared/schema.ts";
import { parseRetryAfter, type FailureKind } from "../failures.ts";

/**
 * 分级冷却：纯函数，时钟由调用方注入。时长按失败类别区分，否则配错的 key 与限流同样冷却
 * 15 分钟，配置错误看起来像限流。本文件不做等待：冷却只影响跨请求的候选排序（`select.ts`），
 * 链内 await 会让客户端只看到网关变慢。
 */

/** 比例式抖动，避免同时失败的 Worker 同一毫秒一起恢复；固定毫秒数对长退避等于没有。 */
const JITTER_RATIO = 0.25;

export type CooldownInput = {
  readonly kind: FailureKind;
  /** 上游的 `Retry-After` 原始头值(未解析)。没有则传 null。 */
  readonly retryAfter: string | null;
  /** 含本次在内的连续失败次数。 */
  readonly consecutiveFails: number;
  readonly config: CooldownConfig;
  readonly now: number;
  /** `[0,1)` 的抖动因子,由调用方注入(生产用 `Math.random()`)。 */
  readonly jitter?: number;
};

/** 把外部传入的抖动因子夹到 `[0,1]`,NaN 视为 0。 */
function clampJitter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 连续失败次数至少算 1：0 会让首次冷却只有基准一半；NaN 会传染成 `now + NaN`，
 * 让 Worker 永久不再就绪。
 */
function normalizeFails(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * 本次失败该冷却多少毫秒；`null` 表示不冷却。穷举 `FailureKind` 并做 `never` 断言，
 * 与 `shouldCooldown` 的一致性由测试对 `FAILURE_KINDS` 逐项交叉验证。
 */
export function cooldownMs(input: CooldownInput): number | null {
  const fails = normalizeFails(input.consecutiveFails);
  const jitter = clampJitter(input.jitter);
  const { config } = input;

  switch (input.kind) {
    // 不变量 #4：坏请求不冷却 Worker；看不懂的失败同样不拿 Worker 可用性去赌。
    case "bad_request":
    case "unknown":
      return null;

    case "rate_limit": {
      /*
       * 尊重 `Retry-After`，但以 `transportBaseMs` 为地板：已过期日期解析为 0，否则持续 429
       * 带 `Retry-After: 0` 的上游会被打成连续重试。上游给了时刻，故不加抖动。
       */
      const asked = parseRetryAfter(input.retryAfter, input.now);
      const base = asked ?? config.rateLimitMs;
      return Math.ceil(Math.max(base, config.transportBaseMs));
    }

    case "auth":
      // 固定短退避不做指数递增：auth 失败几乎总是配置错误，必须持续可见才会被修。
      return Math.ceil(config.authFailMs * (1 + JITTER_RATIO * jitter));

    case "forbidden":
      // 固定短冷却，理由同 auth；时长见 `CooldownConfigSchema.forbiddenMs`。
      return Math.ceil(config.forbiddenMs * (1 + JITTER_RATIO * jitter));

    case "upstream_error":
    case "transport":
    case "timeout": {
      // 指数退避；溢出成 Infinity 经 `Math.min` 正好落在上限，到顶后抖动被吸收（可接受）。
      const raw = config.transportBaseMs * 2 ** (fails - 1);
      const jittered = raw * (1 + JITTER_RATIO * jitter);
      return Math.ceil(Math.min(jittered, config.transportMaxMs));
    }

    default: {
      const exhaustive: never = input.kind;
      throw new Error(`未处理的失败类别:${String(exhaustive)}`);
    }
  }
}

/**
 * 冷却到哪个时刻；`null` 表示不冷却。`now` 非有限值时不冷却：NaN 时刻会让 Worker 永久
 * 不就绪，而不冷却是保守方向（最多多打一次上游）。
 */
export function cooldownUntil(input: CooldownInput): number | null {
  if (!Number.isFinite(input.now)) return null;
  const ms = cooldownMs(input);
  return ms === null ? null : input.now + ms;
}
