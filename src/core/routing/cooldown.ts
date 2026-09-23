import type { CooldownConfig } from "../../shared/schema.ts";
import { parseRetryAfter, shouldCooldown, type FailureKind } from "../failures.ts";

/**
 * 分级冷却 —— 纯函数,时钟由调用方注入。
 *
 * 「冷却多久」完全由失败类别决定,不同类别的处置差异很大,把它们混成一条
 * 统一退避是旧项目的做法,后果是:一个配错的 key 与一次上游限流得到同样的
 * 15 分钟,于是**配置错误看起来像限流**,用户等了 15 分钟发现还是不行。
 *
 * ## 为什么本文件不做「等待」
 *
 * 冷却只影响**跨请求**的候选排序(`select.ts` 读它),不产生任何 sleep。
 * 链内不等待是 Phase 2 的刻意决定:换 Worker 发生在请求**之间**。
 * 一旦这里 await,一条客户端请求的时延就会包含我们自己的退避 ——
 * 而客户端(OpenCode)有自己的超时,它只会看到网关变慢。
 */

/**
 * 抖动比例。
 *
 * 两个 Worker 因同一次上游故障同时失败时,不加抖动它们会在同一毫秒一起
 * 恢复,于是下一波请求把同一个仍未恢复的上游再打一遍。比例式而非固定
 * 毫秒数(旧项目是 `Math.random() * 1000`):固定值对 2 秒的退避是 ±50%,
 * 对 120 秒的退避等于没有。
 */
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
 * 连续失败次数至少算 1 次。
 *
 * 0 会让指数项变成 `2 ** -1 = 0.5`,于是**首次失败的冷却只有基准的一半** ——
 * 比我们声明的最小退避还短。NaN 更糟:`Math.max(1, Math.floor(NaN))` 是
 * **NaN**(不是 1),会一路传染到 `now + NaN`,而 `NaN <= now` 为 false,
 * 于是那个 Worker **永久**不再就绪 —— 一次脏输入把 Worker 悄悄弄没了。
 */
function normalizeFails(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * 本次失败该冷却多少毫秒;`null` 表示不冷却。
 *
 * 穷举 `FailureKind` 的每个分支并在 default 处做 `never` 断言:新增一个类别时
 * **编译失败**,而不是静默落进某个兜底分支。这与 `shouldCooldown` 的一致性
 * 由测试对 `FAILURE_KINDS` 逐项交叉验证(两处都表达"该不该冷却",不能分叉)。
 */
export function cooldownMs(input: CooldownInput): number | null {
  const fails = normalizeFails(input.consecutiveFails);
  const jitter = clampJitter(input.jitter);
  const { config } = input;

  switch (input.kind) {
    /*
     * 请求本身的问题 —— 不变量 #4。
     *
     * 400/422 换 Worker 也一样失败,冷却它等于让一个客户端的坏请求把所有
     * 健康 Worker 逐个打掉。`unknown` 同样保守处理:我们没看懂的失败不该
     * 拿 Worker 的可用性去赌。
     */
    case "bad_request":
    case "unknown":
      return null;

    case "rate_limit": {
      /*
       * 上游给了 `Retry-After` 就用它,不自己另算一个更短的 ——
       * 刚被限流就提前重试通常换来更长的封禁。
       *
       * **但要有下限。** `parseRetryAfter` 对"合法但已过期的日期"正确地返回 0
       * (那确实表示现在就能重试),而 0 会让这个 Worker 立刻重新就绪,
       * 于是一个持续 429 且带 `Retry-After: 0` 的上游会被客户端的请求频率
       * 直接打成连续重试。取 `transportBaseMs` 做地板:它本就是本网关
       * 「最短的一次冷却」,而且只会让我们比上游要求的**更保守**,
       * 不会违背"尊重 Retry-After"。
       *
       * 这一支刻意**不加抖动**:上游明确说了时刻,抖动只是把它变模糊。
       */
      const asked = parseRetryAfter(input.retryAfter, input.now);
      const base = asked ?? config.rateLimitMs;
      return Math.ceil(Math.max(base, config.transportBaseMs));
    }

    case "auth":
      /*
       * 鉴权失败用**固定**短退避,不做指数递增。
       *
       * 这是与旧项目(`markAuthFailed` 按次数翻倍)刻意不同的判断:auth 失败
       * 几乎总是**配置错误**(key 粘错、被吊销、额度耗尽),而配置错误只有被
       * 用户看见才会修好。指数递增会让「key 配错了」随时间逐渐变成
       * 「网关有点慢」—— 正好抹掉这条短退避存在的理由。
       *
       * 失败次数仍然被记录(`consecutiveFails`),供诊断展示"连续失败 N 次",
       * 只是不参与本支的时长计算。
       */
      return Math.ceil(config.authFailMs * (1 + JITTER_RATIO * jitter));

    case "upstream_error":
    case "transport":
    case "timeout": {
      /*
       * 指数退避。`2 ** (fails - 1)` 在 fails 很大时会溢出成 Infinity,
       * 经 `Math.min` 后正好落在上限上 —— 这是对的,不必额外处理。
       *
       * 抖动加在**取上限之前**:超出上限的部分被上限吸收,所以到顶之后
       * 抖动不再起作用。这是可接受的 —— 到顶意味着连续失败很多次,
       * 那时问题不在"两个 Worker 同时醒来",而在上游整体不可用。
       */
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
 * 冷却到哪个时刻;`null` 表示不冷却。
 *
 * 与 `cooldownMs` 分开只为让调用方不必自己做加法 —— 那种加法散在多处时,
 * 「是时长还是时刻」的混淆会变成一个定位很久的 bug。
 *
 * **`now` 非有限值时返回 null**(不冷却),而不是算出一个 NaN 时刻。
 * `NaN` 写进 `cooldownUntil` 会让 `NaN <= now` 恒为 false,于是那个 Worker
 * **永久**不再就绪 —— 一次脏输入把 Worker 悄悄弄没了,没有任何报错。
 * 这正是 `normalizeFails` 注释描述的后果,而它当时只防住了失败计数一个入口;
 * 第五轮审核指出 `now` 是这套防护里唯一的缺口。
 *
 * 选"不冷却"而不是"用默认时长":`now` 坏了说明调用方的时钟有问题,
 * 此时任何时长都算不出正确的到期时刻,而不冷却是**保守**方向
 * (最多多打一次上游,而不是永久丢掉一个 Worker)。
 */
export function cooldownUntil(input: CooldownInput): number | null {
  if (!Number.isFinite(input.now)) return null;
  const ms = cooldownMs(input);
  return ms === null ? null : input.now + ms;
}

/**
 * 供诊断:这个类别会不会冷却。
 *
 * 只是 `failures.ts` 的转出,不复制判断 —— 两份「该不该冷却」的名单必然分叉,
 * 而分叉方向是漏(新增类别时一处更新一处不更新)。
 */
export { shouldCooldown };
