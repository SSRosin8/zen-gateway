import { describe, expect, it, vi } from "vitest";
import { Response as UndiciResponse } from "undici";
import { runRetryChain, type AttemptRecord, type AttemptTarget } from "../../src/core/upstream/retry.ts";
import { EgressSetupError } from "../../src/core/upstream/fetch.ts";
import type { UpstreamDeps } from "../../src/core/upstream/fetch.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { DispatcherPool } from "../../src/core/proxy/dispatcher.ts";
import { SelectorLockRegistry } from "../../src/core/proxy/selectorLock.ts";

/** 最小可用配置：无代理，直连出口。 */
function config(): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "test-token-not-real-value" },
  });
}

function targets(n: number): AttemptTarget[] {
  return Array.from({ length: n }, (_, i) => ({
    workerId: `w${i + 1}`,
    apiKey: `key-${i + 1}-not-real`,
    proxyId: null,
  }));
}

/**
 * 造一个受控的 deps，fetch 按脚本依次返回。
 *
 * 脚本项可以是 Response、也可以是要抛的错误。
 */
function deps(script: Array<UndiciResponse | Error>): {
  deps: UpstreamDeps;
  calls: () => number;
} {
  let i = 0;
  const pool = new DispatcherPool({ headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
  return {
    calls: () => i,
    deps: {
      config: config(),
      dispatchers: pool,
      locks: new SelectorLockRegistry(),
      controllerFor: () => null,
      fetchImpl: (async () => {
        const item = script[i];
        i += 1;
        if (item === undefined) throw new Error("脚本用尽：被多调用了一次");
        if (item instanceof Error) throw item;
        return item;
      }) as unknown as NonNullable<UpstreamDeps["fetchImpl"]>,
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new UndiciResponse(JSON.stringify(body), { status, headers });
}

const baseInput = {
  maxAttempts: 3,
  url: "https://upstream.invalid/v1/chat/completions",
  method: "POST",
  body: new TextEncoder().encode('{"model":"x-free"}'),
  buildHeaders: (t: AttemptTarget) => ({ authorization: `Bearer ${t.apiKey}` }),
};

describe("重试链：成功路径", () => {
  it("首个 Worker 成功则不再尝试其他", async () => {
    const d = deps([jsonResponse(200, { ok: true })]);
    const r = await runRetryChain({ ...baseInput, targets: targets(3), deps: d.deps });

    expect(r.ok).toBe(true);
    expect(d.calls()).toBe(1);
    if (r.ok) expect(r.workerId).toBe("w1");
  });

  it("成功时响应体**未被消费** —— 不变量 #1", async () => {
    /*
     * 这是整条不变量的核心：重试链只看 status + headers，body 必须完整留给
     * pipe.ts 写给客户端。一旦这里读了 body，流式响应就无法再转发。
     */
    const d = deps([jsonResponse(200, { content: "hello" })]);
    const r = await runRetryChain({ ...baseInput, targets: targets(1), deps: d.deps });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.bodyUsed).toBe(false);
      // 仍然读得出完整内容 —— 证明没被提前消费掉。
      expect(await r.response.json()).toEqual({ content: "hello" });
    }
  });

  it("每次尝试用各自 Worker 的 key", async () => {
    const seen: string[] = [];
    const d = deps([jsonResponse(500, {}), jsonResponse(200, {})]);
    await runRetryChain({
      ...baseInput,
      targets: targets(2),
      deps: d.deps,
      buildHeaders: (t) => {
        seen.push(t.apiKey);
        return { authorization: `Bearer ${t.apiKey}` };
      },
    });
    expect(seen).toEqual(["key-1-not-real", "key-2-not-real"]);
  });
});

describe("重试链：失败与重试", () => {
  it("5xx 换下一个 Worker", async () => {
    const d = deps([jsonResponse(500, {}), jsonResponse(200, { ok: true })]);
    const r = await runRetryChain({ ...baseInput, targets: targets(2), deps: d.deps });

    expect(r.ok).toBe(true);
    expect(d.calls()).toBe(2);
    if (r.ok) expect(r.workerId).toBe("w2");
  });

  it("429 换下一个并记下 retry-after", async () => {
    const records: AttemptRecord[] = [];
    const d = deps([
      jsonResponse(429, {}, { "retry-after": "30" }),
      jsonResponse(200, {}),
    ]);
    await runRetryChain({
      ...baseInput,
      targets: targets(2),
      deps: d.deps,
      onAttempt: (r) => records.push(r),
    });

    expect(records[0]!.failure).toBe("rate_limit");
    expect(records[0]!.retryAfter).toBe("30");
    expect(records[0]!.blameWorker).toBe(true);
  });

  it("401 **不在链内**重试 —— 换 Worker 由冷却跨请求完成", async () => {
    /*
     * 这条断言的方向与直觉相反，记下依据：
     *
     * Phase 2 定下 `isRetryable("auth") === false` 而 `shouldCooldown("auth") === true`。
     * 于是「换 Worker」发生在**请求之间**而非请求之内：这次请求把坏 key 的 Worker
     * 打进短冷却（默认 60s）并把 401 原样返回客户端，下一个请求就会跳过它。
     *
     * 代价是**一个冷却周期内会有一次用户可见的失败**。好处是配错的 key 会暴露，
     * 而不是被链内重试静默补偿掉（`authFailMs` 默认 60s 而非 15min 正是这个用意）。
     *
     * 我最初把这条写成「链内换下一个」并被驳回。核对后确认是断言错、代码对。
     * 是否改成链内重试见 plan 里给 Phase 5 留的待决问题。
     */
    const d = deps([jsonResponse(401, { error: "invalid key" })]);
    const r = await runRetryChain({ ...baseInput, targets: targets(2), deps: d.deps });

    expect(r.ok).toBe(false);
    expect(d.calls()).toBe(1);
    if (!r.ok) {
      expect(r.kind).toBe("auth");
      // 401 的响应体原样保留 —— 客户端要看到上游说的是 key 无效还是额度耗尽。
      expect(await r.response!.json()).toEqual({ error: "invalid key" });
    }
  });

  it("401 归咎于 Worker（要冷却），与 400 相反", async () => {
    const records: AttemptRecord[] = [];
    const d = deps([jsonResponse(401, {})]);
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });
    expect(records[0]!.blameWorker).toBe(true);
  });

  it("maxAttempts 限制尝试次数，即使还有候选", async () => {
    const d = deps([jsonResponse(500, {}), jsonResponse(500, {}), jsonResponse(500, {})]);
    const r = await runRetryChain({
      ...baseInput,
      targets: targets(5),
      maxAttempts: 2,
      deps: d.deps,
    });
    expect(r.ok).toBe(false);
    expect(d.calls()).toBe(2);
    expect(r.attempts).toHaveLength(2);
  });

  it("候选数少于 maxAttempts 时不越界", async () => {
    const d = deps([jsonResponse(500, {})]);
    const r = await runRetryChain({ ...baseInput, targets: targets(1), maxAttempts: 5, deps: d.deps });
    expect(r.ok).toBe(false);
    expect(d.calls()).toBe(1);
  });

  it("没有候选 Worker 时如实报错，不发请求", async () => {
    const d = deps([]);
    const r = await runRetryChain({ ...baseInput, targets: [], deps: d.deps });
    expect(r.ok).toBe(false);
    expect(d.calls()).toBe(0);
    if (!r.ok) expect(r.reason).toContain("没有可用的 Worker");
  });
});

describe("不变量 #2：body 取消的非对称性", () => {
  it("非最后一次尝试的 body 被取消（否则连接悬挂）", async () => {
    const first = jsonResponse(500, { err: "boom" });
    const cancelSpy = vi.spyOn(first.body!, "cancel");

    const d = deps([first, jsonResponse(200, {})]);
    await runRetryChain({ ...baseInput, targets: targets(2), deps: d.deps });

    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it("最后一次尝试**保留** body —— 客户端要看到上游真实的错误负载", async () => {
    /*
     * 这条与上一条方向相反，正是「非对称」的含义。
     * 若最后一次也取消，客户端只能得到网关编的话，看不到上游为何拒绝
     * —— 例如 FreeTierError 的具体说明。
     */
    const last = jsonResponse(429, { error: { message: "上游的真实说明" } });
    const d = deps([last]);
    const r = await runRetryChain({ ...baseInput, targets: targets(1), deps: d.deps });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response).not.toBeNull();
      expect(r.response!.bodyUsed).toBe(false);
      expect(await r.response!.json()).toEqual({ error: { message: "上游的真实说明" } });
    }
  });

  it("body.cancel 抛错不会盖住真正的失败", async () => {
    const first = jsonResponse(500, {});
    vi.spyOn(first.body!, "cancel").mockRejectedValue(new Error("cancel 失败"));

    const d = deps([first, jsonResponse(200, {})]);
    const r = await runRetryChain({ ...baseInput, targets: targets(2), deps: d.deps });
    // 仍然走到第二个并成功。
    expect(r.ok).toBe(true);
  });
});

describe("不变量 #4：不可重试的 4xx 不归咎于 Worker", () => {
  it("400 不重试且 blameWorker 为 false", async () => {
    /*
     * 400/422 是**请求本身**的问题。若归咎于 Worker，一个客户端的坏请求
     * 会把所有健康 Worker 逐个打进冷却 —— 一次拼错的请求体就能让整个网关瘫痪。
     */
    const records: AttemptRecord[] = [];
    const d = deps([jsonResponse(400, { error: "字段错" })]);
    const r = await runRetryChain({
      ...baseInput,
      targets: targets(3),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });

    expect(d.calls()).toBe(1); // 不重试
    expect(records).toHaveLength(1);
    expect(records[0]!.failure).toBe("bad_request");
    expect(records[0]!.blameWorker).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("422 同样不重试", async () => {
    const d = deps([jsonResponse(422, {})]);
    await runRetryChain({ ...baseInput, targets: targets(3), deps: d.deps });
    expect(d.calls()).toBe(1);
  });

  it("400 的响应体仍原样保留给客户端", async () => {
    const d = deps([jsonResponse(400, { error: { param: "messages" } })]);
    const r = await runRetryChain({ ...baseInput, targets: targets(1), deps: d.deps });
    if (!r.ok) expect(await r.response!.json()).toEqual({ error: { param: "messages" } });
  });
});

describe("出口配置错误与网络失败的区分", () => {
  it("EgressSetupError 不归咎于 Worker", async () => {
    /*
     * 出口配置错误（代理不存在、只能桥接但 Clash 关着）换任何 Worker 都不会好。
     * 记成 Worker 故障会让健康 Worker 被冷却，而真正的原因被掩盖。
     */
    const records: AttemptRecord[] = [];
    const d = deps([new EgressSetupError("代理 p1 不存在")]);
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });

    expect(records[0]!.blameWorker).toBe(false);
    expect(records[0]!.failure).toBe("bad_request");
  });

  it("网络失败归咎于 Worker（换一个可能就好）", async () => {
    const records: AttemptRecord[] = [];
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const d = deps([err, jsonResponse(200, {})]);
    await runRetryChain({
      ...baseInput,
      targets: targets(2),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });

    expect(records[0]!.blameWorker).toBe(true);
    expect(records[0]!.failure).toBe("transport");
  });

  it("网络失败后继续尝试下一个", async () => {
    const d = deps([new Error("boom"), jsonResponse(200, {})]);
    const r = await runRetryChain({ ...baseInput, targets: targets(2), deps: d.deps });
    expect(r.ok).toBe(true);
  });

  it("抛出的异常消息经过脱敏后才进 reason", async () => {
    const d = deps([new Error("failed to connect to https://user:SECRET-PW@proxy.invalid")]);
    const r = await runRetryChain({ ...baseInput, targets: targets(1), deps: d.deps });
    if (!r.ok) expect(r.reason).not.toContain("SECRET-PW");
  });
});

describe("尝试记录", () => {
  it("每次尝试都有一条记录，顺序与尝试一致", async () => {
    const records: AttemptRecord[] = [];
    const d = deps([jsonResponse(500, {}), jsonResponse(503, {}), jsonResponse(200, {})]);
    const r = await runRetryChain({
      ...baseInput,
      targets: targets(3),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });

    expect(records.map((x) => x.workerId)).toEqual(["w1", "w2", "w3"]);
    expect(records.map((x) => x.failure)).toEqual(["upstream_error", "upstream_error", null]);
    if (r.ok) expect(r.attempts).toHaveLength(3);
  });

  it("成功的那次记录 failure 为 null,并带上状态码与耗时", async () => {
    const records: AttemptRecord[] = [];
    const d = deps([jsonResponse(200, {})]);
    // 注入时钟:耗时要能被确切断言,而不是"大于等于 0"那种恒真的写法。
    let t = 1_000;
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
      clock: () => (t += 25),
    });
    expect(records[0]).toEqual({
      workerId: "w1",
      failure: null,
      blameWorker: false,
      retryAfter: null,
      // Phase 7 新增:统计要按尝试记状态码与耗时。
      status: 200,
      latencyMs: 25,
    });
  });

  it("`latencyMs` 恒为**非负整数** —— 时钟倒退或给小数都不会污染存储（缺口 #19）", async () => {
    /*
     * 两个都不是理论问题，是喂真 SQLite 实测过的：
     *
     * - `1.5` 进 `upstream_attempts.latency_ms`（STRICT 表的 INTEGER 列）被拒
     *   （`cannot store REAL value in INTEGER column`）→ `recordAttempt`
     *   **整条事务回滚** → 明细与累计两条记录一起丢，只留一个 writeFailures。
     * - `-5000` **照常写进库**，于是"平均延迟"被一个负值拉偏而没人会喊。
     *
     * 生产上 `clock` 恒为 `Date.now` 所以两者都不可达 —— 但 `clock` 是
     * 可注入的（测试要控时钟），而"这个参数只有测试会传奇怪的值"不是一个
     * 能长期依赖的前提。
     */
    // 一、小数时钟 → 必须取整。
    const fractional: AttemptRecord[] = [];
    let f = 1_000;
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: deps([jsonResponse(200, {})]).deps,
      onAttempt: (x) => fractional.push(x),
      clock: () => (f += 25.7),
    });
    expect(Number.isInteger(fractional[0]!.latencyMs)).toBe(true);
    expect(fractional[0]!.latencyMs).toBe(26);

    // 二、倒退的时钟（NTP 校时、或注入了一个递减的实现）→ 夹到 0，不出负数。
    const backwards: AttemptRecord[] = [];
    let b = 1_000;
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: deps([jsonResponse(200, {})]).deps,
      onAttempt: (x) => backwards.push(x),
      clock: () => (b -= 5_000),
    });
    expect(backwards[0]!.latencyMs).toBe(0);
    expect(backwards[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /*
   * 建连之前就失败时 `status` 必须是 **null** 而不是 0。
   *
   * 0 会让「网关自己没连上」和「上游返回了某个码」在统计里混成一类,
   * 而这两者的排查方向完全相反(查本机出口 vs 查上游)。
   */
  it("传输失败的那次 status 为 null,不是 0", async () => {
    const records: AttemptRecord[] = [];
    const d = deps([new Error("连不上")]);
    await runRetryChain({
      ...baseInput,
      targets: targets(1),
      deps: d.deps,
      onAttempt: (x) => records.push(x),
    });
    expect(records[0]?.status).toBeNull();
  });
});
