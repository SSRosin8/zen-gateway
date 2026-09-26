import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/shared/schema.ts";
import { cooldownMs, cooldownUntil } from "../../src/core/routing/cooldown.ts";
import { FAILURE_KINDS, shouldCooldown, type FailureKind } from "../../src/core/failures.ts";
import { CooldownConfigSchema, type CooldownConfig } from "../../src/shared/schema.ts";

/**
 * 分级冷却的单测。全部注入时钟与抖动 —— 没有一条依赖真实时间。
 */

const config: CooldownConfig = CooldownConfigSchema.parse({});
const NOW = 1_800_000_000_000;

function ms(over: {
  kind: FailureKind;
  retryAfter?: string | null;
  fails?: number;
  jitter?: number;
  now?: number;
  config?: CooldownConfig;
}): number | null {
  return cooldownMs({
    kind: over.kind,
    retryAfter: over.retryAfter ?? null,
    consecutiveFails: over.fails ?? 1,
    config: over.config ?? config,
    now: over.now ?? NOW,
    ...(over.jitter !== undefined ? { jitter: over.jitter } : {}),
  });
}

describe("与 shouldCooldown 的一致性", () => {
  /*
   * 两处都表达「该不该冷却」,必须逐个类别交叉验证。
   *
   * 这条测试存在的理由是纪律 #4:两份并行的判断必然分叉,而分叉方向是漏 ——
   * 新增一个类别时只改了一处,于是某个失败静默地不再冷却(或反过来,
   * 一个请求侧的错误开始打健康 Worker)。用 FAILURE_KINDS 遍历而不是手写
   * 列表,是同一条纪律的另一半:手写的清单不会跟着类型走。
   */
  it.each(FAILURE_KINDS)("%s:cooldownMs 与 shouldCooldown 不得分叉", (kind) => {
    const value = ms({ kind });
    expect(value === null).toBe(!shouldCooldown(kind));
  });

  it("FAILURE_KINDS 覆盖了全部类别(否则上面那条遍历是空壳)", () => {
    // 类别数写死:新增一个类别时这条会红,提醒去看上面的遍历是否仍然成立。
    expect(FAILURE_KINDS).toHaveLength(8);
    expect(new Set(FAILURE_KINDS).size).toBe(FAILURE_KINDS.length);
  });
});

describe("bad_request / unknown 不冷却", () => {
  it("bad_request 返回 null —— 不变量 #4", () => {
    /*
     * 400/422 是请求本身的问题。若冷却它,一个客户端的坏请求会把所有健康
     * Worker 逐个打掉 —— 一次拼错的请求体就能让整个网关瘫痪。
     */
    expect(ms({ kind: "bad_request", fails: 9 })).toBeNull();
  });

  it("unknown 返回 null", () => {
    expect(ms({ kind: "unknown", fails: 9 })).toBeNull();
  });

  it("cooldownUntil 对不冷却的类别同样返回 null", () => {
    expect(cooldownUntil({
      kind: "bad_request",
      retryAfter: null,
      consecutiveFails: 1,
      config,
      now: NOW,
    })).toBeNull();
  });
});

describe("rate_limit:尊重 Retry-After", () => {
  it("有 Retry-After 时用它,不用配置里的默认值", () => {
    expect(ms({ kind: "rate_limit", retryAfter: "120" })).toBe(120_000);
  });

  it("没有 Retry-After 时用配置的 rateLimitMs", () => {
    expect(ms({ kind: "rate_limit" })).toBe(config.rateLimitMs);
  });

  it("畸形 Retry-After 退回配置值,而不是 0", () => {
    /*
     * 0 意味着「立刻重试」,而这个头几乎只出现在 429 上 —— 刚被限流就立刻
     * 重试通常换来更长的封禁。`parseRetryAfter` 对畸形输入返回 null,
     * 这里必须把 null 当作「没给」而不是「给了 0」。
     */
    for (const bad of ["-5", "Nov 6", "abc", "", "  ", "1.5"]) {
      expect(ms({ kind: "rate_limit", retryAfter: bad })).toBe(config.rateLimitMs);
    }
  });

  it("Retry-After 为 0(或已过期的日期)也有地板,不会立刻重新就绪", () => {
    /*
     * `parseRetryAfter` 对「合法但已过期的日期」正确地返回 0 —— 那确实表示
     * 现在就能重试。但 0 会让 Worker 立刻重新就绪,于是一个持续 429 且带
     * `Retry-After: 0` 的上游被客户端的请求频率直接打成连续重试。
     *
     * 地板取 transportBaseMs:本网关最短的一次冷却,只会比上游要求的更保守。
     */
    expect(ms({ kind: "rate_limit", retryAfter: "0" })).toBe(config.transportBaseMs);

    const past = new Date(NOW - 60_000).toUTCString();
    expect(ms({ kind: "rate_limit", retryAfter: past })).toBe(config.transportBaseMs);
  });

  it("Retry-After 比地板长时原样采用", () => {
    // 地板只做下限,不得把上游要求的长冷却缩短。
    expect(ms({ kind: "rate_limit", retryAfter: "3600" })).toBe(3_600_000);
  });

  it("HTTP-date 形态按到期时刻算", () => {
    const at = new Date(NOW + 300_000).toUTCString();
    // toUTCString 只有秒精度,允许 1 秒误差。
    expect(ms({ kind: "rate_limit", retryAfter: at })).toBeGreaterThan(299_000);
    expect(ms({ kind: "rate_limit", retryAfter: at })).toBeLessThanOrEqual(300_000);
  });

  it("不加抖动 —— 上游说了确切时刻,抖动只是把它变模糊", () => {
    expect(ms({ kind: "rate_limit", retryAfter: "120", jitter: 0 })).toBe(120_000);
    expect(ms({ kind: "rate_limit", retryAfter: "120", jitter: 1 })).toBe(120_000);
  });

  it("失败次数不影响 rate_limit —— 它不做指数退避", () => {
    expect(ms({ kind: "rate_limit", retryAfter: "60", fails: 1 })).toBe(60_000);
    expect(ms({ kind: "rate_limit", retryAfter: "60", fails: 8 })).toBe(60_000);
  });
});

describe("auth:固定短退避,不随次数增长", () => {
  it("零抖动时就是配置里的 authFailMs", () => {
    expect(ms({ kind: "auth", jitter: 0 })).toBe(config.authFailMs);
  });

  it("连续失败 10 次仍是同一个量级", () => {
    /*
     * 这是刻意不按次数翻倍的判断(那是最自然的写法)。
     *
     * auth 失败几乎总是配置错误(key 粘错、被吊销、额度耗尽),而配置错误
     * 只有被用户看见才会修好。指数递增会让「key 配错了」随时间逐渐变成
     * 「网关有点慢」—— 正好抹掉这条短退避存在的理由。
     */
    expect(ms({ kind: "auth", fails: 10, jitter: 0 })).toBe(config.authFailMs);
    expect(ms({ kind: "auth", fails: 100, jitter: 0 })).toBe(config.authFailMs);
  });

  it("远短于 rate_limit —— 否则配置错误会伪装成限流", () => {
    const authMs = ms({ kind: "auth", jitter: 0 });
    const limitMs = ms({ kind: "rate_limit" });
    expect(authMs).not.toBeNull();
    expect(limitMs).not.toBeNull();
    expect(authMs!).toBeLessThan(limitMs!);
  });

  it("抖动最多加 25%", () => {
    expect(ms({ kind: "auth", jitter: 1 })).toBe(Math.ceil(config.authFailMs * 1.25));
  });
});

describe("forbidden:固定且比 auth 更短的冷却", () => {
  it("零抖动时就是配置里的 forbiddenMs,且不随次数增长", () => {
    expect(ms({ kind: "forbidden", jitter: 0 })).toBe(config.forbiddenMs);
    expect(ms({ kind: "forbidden", fails: 10, jitter: 0 })).toBe(config.forbiddenMs);
  });

  it("默认只有几秒,短于 auth —— 免费闸门的 403 取决于请求形态", () => {
    expect(config.forbiddenMs).toBeLessThanOrEqual(10_000);
    expect(ms({ kind: "forbidden", jitter: 0 })!).toBeLessThan(ms({ kind: "auth", jitter: 0 })!);
  });

  it("抖动最多加 25%", () => {
    expect(ms({ kind: "forbidden", jitter: 1 })).toBe(Math.ceil(config.forbiddenMs * 1.25));
  });
});

describe("transport / timeout / upstream_error:指数退避", () => {
  it.each(["transport", "timeout", "upstream_error"] as FailureKind[])(
    "%s 首次失败是基准值",
    (kind) => {
      expect(ms({ kind, fails: 1, jitter: 0 })).toBe(config.transportBaseMs);
    },
  );

  it("按 2^(n-1) 增长", () => {
    expect(ms({ kind: "transport", fails: 1, jitter: 0 })).toBe(2_000);
    expect(ms({ kind: "transport", fails: 2, jitter: 0 })).toBe(4_000);
    expect(ms({ kind: "transport", fails: 3, jitter: 0 })).toBe(8_000);
    expect(ms({ kind: "transport", fails: 4, jitter: 0 })).toBe(16_000);
  });

  it("到上限就停住,不无限增长", () => {
    expect(ms({ kind: "transport", fails: 20, jitter: 0 })).toBe(config.transportMaxMs);
    // 极大次数下 2**n 溢出成 Infinity,Math.min 正好落在上限上。
    expect(ms({ kind: "transport", fails: 5_000, jitter: 0 })).toBe(config.transportMaxMs);
  });

  it("抖动在上限之内按比例加", () => {
    expect(ms({ kind: "transport", fails: 1, jitter: 1 })).toBe(2_500);
    expect(ms({ kind: "transport", fails: 1, jitter: 0.5 })).toBe(2_250);
  });

  it("抖动是比例式而非固定毫秒 —— 对长退避同样有效", () => {
    /*
     * 固定毫秒抖动(比如 `Math.random() * 1000`):对 2 秒的退避是 ±50%,
     * 对 120 秒的退避等于没有 —— 而两个 Worker 同时恢复正是长退避下
     * 更需要避免的(它们会把同一个仍未恢复的上游再打一遍)。
     */
    const base = ms({ kind: "transport", fails: 4, jitter: 0 })!;
    const jittered = ms({ kind: "transport", fails: 4, jitter: 1 })!;
    expect(jittered - base).toBeGreaterThan(1_000);
  });
});

describe("脏输入不得让 Worker 永久消失", () => {
  it("consecutiveFails 为 0 时按 1 算,不是基准的一半", () => {
    // 0 会让指数项变成 2**-1 = 0.5,比声明的最小退避还短。
    expect(ms({ kind: "transport", fails: 0, jitter: 0 })).toBe(config.transportBaseMs);
  });

  it("consecutiveFails 为 NaN / Infinity 时不产出 NaN", () => {
    /*
     * 这是本文件最要紧的一条。`Math.max(1, Math.floor(NaN))` 是 **NaN**
     * (不是 1),会一路传染到 `now + NaN`;而 `NaN <= now` 为 false,
     * 于是那个 Worker **永久**不再就绪 —— 一次脏输入把 Worker 悄悄弄没了,
     * 没有任何报错。
     */
    for (const dirty of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const value = ms({ kind: "transport", fails: dirty, jitter: 0 });
      expect(value).not.toBeNull();
      expect(Number.isFinite(value!)).toBe(true);
    }
  });

  it("jitter 为 NaN / 越界值时被夹住", () => {
    expect(ms({ kind: "transport", fails: 1, jitter: Number.NaN })).toBe(2_000);
    expect(ms({ kind: "transport", fails: 1, jitter: -5 })).toBe(2_000);
    expect(ms({ kind: "transport", fails: 1, jitter: 99 })).toBe(2_500);
  });

  it("任何输入组合下都产出整数毫秒", () => {
    /*
     * 非整数会流进 `cooldownUntil` 与 sqlite 的 INTEGER 列。
     * 前者让 `<=` 比较出现亚毫秒的边界抖动,后者在 STRICT 表上直接写失败。
     */
    for (const kind of FAILURE_KINDS) {
      for (const fails of [1, 2, 3, 7]) {
        for (const jitter of [0, 0.333, 0.777, 1]) {
          const value = ms({ kind, fails, jitter });
          if (value !== null) expect(Number.isInteger(value)).toBe(true);
        }
      }
    }
  });
});

describe("cooldownUntil", () => {
  it("是 now + 时长", () => {
    const until = cooldownUntil({
      kind: "rate_limit",
      retryAfter: "60",
      consecutiveFails: 1,
      config,
      now: NOW,
    });
    expect(until).toBe(NOW + 60_000);
  });
});

/* ================================================================== *
 * 非有限 now 的守卫
 * ================================================================== */

describe("cooldownUntil 对非有限 now 返回 null", () => {
  /*
   * 这行 `Number.isFinite(input.now)` 只有这里守着 —— 删掉它后其余测试全绿。
   *
   * 它的价值在于**选对了保守方向**：去掉之后算出 `NaN` / `±Infinity` 写进
   * `cooldownUntil`，而下游 `isWorkerReady` 的守卫会把它们全判成不就绪 ——
   * 也就是 Worker **永久消失**。返回 null（不冷却）则最多多打一次上游。
   *
   * 两种都不会让它错误地变就绪，所以这不是安全缺陷；但「永久丢掉一个 Worker」
   * 与「多打一次上游」的代价差得很远，而那正是这个守卫要选的那一边。
   */

  const cfg = () => ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "cooldown-test-token-xx" },
    workers: [{ id: "w1", kind: "authenticated", apiKey: "k".repeat(20), proxyId: null }],
  }).routing.cooldown;

  it.each([
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("now 为 %s 时返回 null，而不是一个 NaN 时刻", (_label, now) => {
    const until = cooldownUntil({
      kind: "rate_limit",
      retryAfter: "900",
      consecutiveFails: 1,
      config: cfg(),
      now,
      jitter: 0,
    });

    // null = 不冷却。去掉守卫这里会是 NaN / ±Infinity。
    expect(until).toBeNull();
  });

  it("有限 now 照常算出时刻 —— 守卫不改变正常路径", () => {
    /*
     * 与上面几条配对：少了它，一个「永远返回 null」的实现也能让它们通过，
     * 而那等于整个冷却机制失效。
     */
    const until = cooldownUntil({
      kind: "rate_limit",
      retryAfter: "900",
      consecutiveFails: 1,
      config: cfg(),
      now: 1_000_000,
      jitter: 0,
    });

    expect(until).not.toBeNull();
    expect(Number.isFinite(until)).toBe(true);
    expect(until).toBeGreaterThan(1_000_000);
  });
});

describe("冷却时长要断言**确切值**,不只是形态", () => {
  it("NaN 失败计数按 1 算,产出恰好等于基准值", () => {
    /*
     * 原断言只查 `Number.isFinite` —— 而把 `normalizeFails` 的 NaN 兜底从
     * 1 改成 **0** 同样产出有限值(0 会让指数项变成 2^-1 = 0.5,即基准的一半)。
     */
    const exact = cooldownMs({
      kind: "transport", retryAfter: null, consecutiveFails: Number.NaN,
      config: config, now: NOW, jitter: 0,
    });
    expect(exact).toBe(config.transportBaseMs);
  });

  it("抖动用 Math.ceil 向上取整,不是 floor", () => {
    /*
     * 原断言只查"是整数",而 floor 同样产出整数。
     * 2000 * (1 + 0.25 * 0.333) = 2166.5 → ceil 2167,floor 2166。
     */
    expect(cooldownMs({
      kind: "transport", retryAfter: null, consecutiveFails: 1,
      config: config, now: NOW, jitter: 0.333,
    })).toBe(2167);
  });
});
