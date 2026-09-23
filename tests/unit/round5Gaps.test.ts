import { describe, expect, it } from "vitest";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { WorkerPool } from "../../src/core/routing/workerPool.ts";
import { AffinityMap, extractBlobHashes } from "../../src/core/routing/affinity.ts";
import { cooldownMs } from "../../src/core/routing/cooldown.ts";
import { pipeUpstreamResponse } from "../../src/core/upstream/pipe.ts";
import { ConfigSchema, CooldownConfigSchema, type Config } from "../../src/shared/schema.ts";
import type { Response as UndiciResponse } from "undici";

/**
 * 第五轮审核补的断言 —— 每一条都对应一个**存活过的变异**。
 *
 * 110 组变异存活 26 组,分成四类(见 AGENTS.md 纪律 #1):测的路径不存在、
 * 条件被另一层顺带满足、调用点存在但输入集为空、代码里有死信息。
 * 前三类补断言(本文件),第四类改代码。
 *
 * 集中放一个文件是刻意的:它们的共同点不是"测同一个模块",而是
 * "先前无法失败"。下一轮审核可以直接拿这个文件核对哪些洞已经堵上。
 */

const NOW = 1_800_000_000_000;
const TTL = 3_600_000;
const always = (): boolean => true;

function config(
  workers: Array<{ id: string; proxyId?: string | null; apiKey?: string }>,
  proxies: Array<{ id: string }> = [],
): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: "unit-test-relay-token-x" },
    proxies: proxies.map((p) => ({
      id: p.id,
      name: `proxy-${p.id}`,
      type: "http",
      // RFC 5737 文档用地址,虚构。
      host: "203.0.113.9",
      port: 8080,
      enabled: true,
      source: "manual",
      direct: true,
    })),
    workers: workers.map((w) => ({
      id: w.id,
      name: "",
      kind: "authenticated",
      apiKey: w.apiKey ?? `fake-key-${w.id}-not-real`,
      enabled: true,
      proxyId: w.proxyId ?? null,
    })),
  });
}

const cooldownCfg = CooldownConfigSchema.parse({});

/* ================================================================== *
 * 一、输入集为空:测试数据从未走到被测分支
 * ================================================================== */

describe("sync 的 proxyId 分支(先前 proxyId 从未真的变过)", () => {
  it("proxyId 真的换一个值时,冷却仍然保留", () => {
    /*
     * 原有那条名为「proxyId 变了**不**重置冷却」的测试,两次都传
     * `proxyId: null` —— 出口根本没变,所以它断言的契约结构上无法被违反。
     * 变异验证:给 `keySame` 加上 `&& prior.proxyId === w.proxyId`(恰好取反
     * 那条测试声明的契约)后全绿。
     *
     * 归类:调用点存在但输入集为空,与 `chatSurface.sessionKeyFrom` 同型。
     */
    const before = config([{ id: "w1", proxyId: null }], [{ id: "p1" }]);
    const after = config([{ id: "w1", proxyId: "p1" }], [{ id: "p1" }]);

    const pool = new WorkerPool(before);
    pool.markFailure({
      workerId: "w1", kind: "rate_limit", retryAfter: "600", config: before, now: NOW, jitter: 0,
    });
    expect(pool.get("w1")?.proxyId).toBeNull();

    pool.sync(after);
    // 出口换了,但额度与鉴权状态没变 —— 冷却必须留着。
    expect(pool.get("w1")?.proxyId).toBe("p1");
    expect(pool.isReady("w1", NOW)).toBe(false);
    expect(pool.get("w1")?.cooldownUntil).toBe(NOW + 600_000);
  });
});

describe("pipe.ts 无 body 的补偿分支(Phase 5 新加,先前零覆盖)", () => {
  /** 造一个 undici 风格的响应。204/304 时 body 为 null,与 undici 实测一致。 */
  function upstreamOf(status: number, body: ReadableStream<Uint8Array> | null): UndiciResponse {
    return {
      status,
      statusText: "",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    } as unknown as UndiciResponse;
  }

  it.each([204, 304])("status %i:onDone 必须被调用一次", (status) => {
    /*
     * 这条分支的注释自己写明了后果(「一次本该学习绑定的成功被静默丢掉,
     * 症状是粘滞偶发失效」),而全仓没有任何测试用 204/304 形态调用过
     * `pipeUpstreamResponse`,更没有配 tap 的 —— 也就是**这个缺陷的修复
     * 没有任何测试守着**,被改回去不会有人知道。
     *
     * 变异验证:删掉整块补偿后测试与 typecheck 都绿。
     */
    let doneCalls = 0;
    let doneError: unknown = "未调用";
    pipeUpstreamResponse(upstreamOf(status, null), {}, {
      onText: () => {},
      onDone: (err) => { doneCalls += 1; doneError = err; },
    });
    expect(doneCalls).toBe(1);
    // 无体响应是"完整"的 —— 结算方靠 null 判断这一点。
    expect(doneError).toBeNull();
  });

  it("body 为 null 但状态码是 200 时同样通知", () => {
    let doneCalls = 0;
    pipeUpstreamResponse(upstreamOf(200, null), {}, {
      onText: () => {},
      onDone: () => { doneCalls += 1; },
    });
    expect(doneCalls).toBe(1);
  });

  it("有 body 时**只**经 tap 通知一次,不叠加补偿", () => {
    // 防的是"既走 tap 又走补偿"——那会让结算跑两遍。
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    let doneCalls = 0;
    const res = pipeUpstreamResponse(upstreamOf(200, body), {}, {
      onText: () => {},
      onDone: () => { doneCalls += 1; },
    });
    // 还没读,所以 tap 尚未触发 —— 关键是补偿没有抢先跑。
    expect(doneCalls).toBe(0);
    expect(res.body).not.toBeNull();
  });
});

describe("statusText 兜底(先前只给过畸形头,没给畸形 statusText)", () => {
  it("畸形 statusText 时退回不带它的构造,响应仍然产出", () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const res = pipeUpstreamResponse(
      {
        status: 200,
        // 含 CR/LF 的 statusText 会让标准 Response 构造抛错。
        statusText: "OK\r\nX-Injected: 1",
        headers: new Headers(),
        body,
      } as unknown as UndiciResponse,
      {},
    );
    expect(res.status).toBe(200);
  });
});

describe("pipe 抛错时必须释放它**自己锁住**的流", () => {
  /**
   * 造一个带 body 的上游响应,状态码可控。
   *
   * `status: 600` 让两次 `new Response()` 构造**都**抛 `RangeError`
   * (实测 undici 8.10.2 会原样透传这类状态行并给出 body 流)。
   */
  function upstreamOf(status: number): { res: UndiciResponse; body: ReadableStream<Uint8Array> } {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
    });
    return {
      res: {
        status,
        statusText: "X",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body,
      } as unknown as UndiciResponse,
      body,
    };
  }

  it("状态码越界导致构造失败时,onDone 仍被通知一次且标记为不完整", async () => {
    /*
     * 第五轮审核查出的最要紧一条。`tapReadable` 内部 `getReader()` 锁住了
     * 上游 body,而 `new Response()` 仍可能抛 —— 此时 `relay.ts` 那层兜底的
     * `upstream.body?.cancel()` 会异步拒绝(流已被锁)并被 `.catch()` 吞掉。
     *
     * 对照实测:
     * ```
     * 无 tap: pipe 抛 RangeError | body.locked=false | cancel → resolved
     * 带 tap: pipe 抛 RangeError | body.locked=true  | cancel → REJECTED
     * ```
     *
     * 三重后果全静默:连接泄漏(上界 = bodyTimeout,5 分钟)、
     * `onDone` 一次都不触发(不变量 #3 整条漏掉)、客户端拿到裸 500。
     *
     * 耐久的结论不是"拦一下 600" —— 而是**谁锁的谁负责释放**。
     * 所以断言的是「pipe 自己完成了处置」,而不是某个状态码被特判。
     */
    const { res } = upstreamOf(600);
    let doneCalls = 0;
    let doneError: unknown = null;

    expect(() =>
      pipeUpstreamResponse(res, {}, {
        onText: () => {},
        onDone: (err) => { doneCalls += 1; doneError = err; },
      }),
    ).toThrow();

    // 取消是异步的,给它一个微任务周期。
    await Promise.resolve();
    await new Promise((r) => { setTimeout(r, 0); });

    expect(doneCalls).toBe(1);
    // 非 null → 结算方按"不完整"处理,既不学习也不遗忘。这是正确的:
    // 客户端根本没收到这个响应。
    expect(doneError).not.toBeNull();
  });

  it("没有 tap 时不代管 body —— 释放责任仍在调用方", () => {
    /*
     * 边界:`pipe` 只释放**自己锁住**的流。没传 tap 时它没锁,
     * 那么 body 仍归调用方处置(`relay.ts` 的兜底能成功 cancel)。
     *
     * 这条防的是"修过头":让 pipe 无条件 cancel 会把一个本可由上层
     * 决定如何处置的 body 提前关掉。
     */
    const { res, body } = upstreamOf(600);
    expect(() => pipeUpstreamResponse(res, {})).toThrow();
    // 没被锁,所以调用方还能释放它。
    expect(body.locked).toBe(false);
  });
});

describe("2xx 的上界(先前 3xx 从未进过 settleStream)", () => {
  it("304 不学习指纹 —— 它不是成功的生成响应", () => {
    /*
     * 变异验证:把 `status >= 300` 改成 `>= 400` 后全绿,因为没有任何用例
     * 用 3xx 调用过 settleStream。
     */
    const cfg = config([{ id: "w1" }]);
    const s = new Scheduler({ jitter: () => 0 });
    s.plan({ config: cfg, now: NOW, sessionHash: null, blobHashes: [] });
    s.settleStream({
      workerId: "w1", sessionHash: null, blobHashes: ["b1"],
      status: 304, staleHit: false, complete: true, now: NOW,
    });
    expect(s.snapshot(cfg, NOW).affinity.blobs).toBe(0);
  });

  it("恰好 299 学习,恰好 300 不学习", () => {
    const cfg = config([{ id: "w1" }]);
    for (const [status, expected] of [[299, 1], [300, 0]] as const) {
      const s = new Scheduler({ jitter: () => 0 });
      s.plan({ config: cfg, now: NOW, sessionHash: null, blobHashes: [] });
      s.settleStream({
        workerId: "w1", sessionHash: null, blobHashes: ["b1"],
        status, staleHit: false, complete: true, now: NOW,
      });
      expect(s.snapshot(cfg, NOW).affinity.blobs).toBe(expected);
    }
  });
});

describe("counts/snapshot 必须自己 sync(先前所有用例都先 plan 过)", () => {
  it("全新 Scheduler 的第一个操作就问 counts", () => {
    /*
     * 变异验证:去掉 `counts`/`snapshot` 里的 `#ensureSynced` 后全绿 ——
     * 因为每条用例都先调了 `plan()`(它会 sync)。而 `/health` 完全可能
     * 在任何转发请求之前就来问池状态。
     */
    const cfg = config([{ id: "w1" }, { id: "w2" }]);
    expect(new Scheduler().counts(cfg, NOW)).toEqual({ ready: 2, total: 2 });
  });

  it("全新 Scheduler 的第一个操作就问 snapshot", () => {
    const cfg = config([{ id: "w1" }]);
    expect(new Scheduler().snapshot(cfg, NOW).workers).toHaveLength(1);
  });
});

describe("LRU 刷新(先前容量用例只插新键,从不重绑已有键)", () => {
  it("重新绑定把条目移到队尾,淘汰的不是它", () => {
    /*
     * `bindSession`/`learnBlobs` 靠"先 delete 再 set"维持
     * 「Map 插入顺序 = LRU 顺序」。变异验证:去掉那个 delete 后全绿,
     * 因为没有任何用例在容量压力下重绑一个已存在的键。
     */
    const map = new AffinityMap();
    // 填到接近上限。
    for (let i = 0; i < 10_000; i += 1) map.bindSession(`h${i}`, "w1", NOW + i, TTL);
    // 重绑最老的那个 —— 它应当移到队尾。
    map.bindSession("h0", "w2", NOW + 20_000, TTL);
    // 再插一个,触发淘汰:被淘汰的该是 h1(现在最老),不是 h0。
    map.bindSession("fresh", "w1", NOW + 20_001, TTL);

    expect(map.lookupSession("h0", NOW + 20_001, TTL, always)).toBe("w2");
    expect(map.lookupSession("h1", NOW + 20_001, TTL, always)).toBeNull();
  });
});

describe("指纹长度边界(先前只测了 5 与 20000,两端都在界外)", () => {
  const pad = (n: number): string => "z".repeat(n);

  it("恰好 16 字符被收集,15 字符不被收集", () => {
    expect(extractBlobHashes({ a: { signature: pad(16) } })).toHaveLength(1);
    expect(extractBlobHashes({ a: { signature: pad(15) } })).toHaveLength(0);
  });

  it("恰好 16384 字符被收集,16385 字符不被收集", () => {
    expect(extractBlobHashes({ a: { signature: pad(16_384) } })).toHaveLength(1);
    expect(extractBlobHashes({ a: { signature: pad(16_385) } })).toHaveLength(0);
  });
});

describe("遍历预算不得误伤真实负载", () => {
  it("30 轮对话的推理块必须**全部**收满", () => {
    /*
     * 与"恶意宽扁体"那条成对:预算修复(压栈也计数)不能把正常多轮对话
     * 的指纹提取砍掉。变异验证:把预算改成 50 后这条会红。
     */
    const body = {
      messages: Array.from({ length: 30 }, (_u, i) => ({
        role: "assistant",
        reasoning: { encrypted_content: `encrypted-blob-${i}-not-real-content` },
      })),
    };
    expect(extractBlobHashes(body)).toHaveLength(30);
  });

  it("恶意「宽而扁」体:预算在**压栈阶段**就耗尽,提取结果为空", () => {
    /*
     * 先前 `visited` 只数出栈,而数组分支在一次 pop 里压入全部元素 ——
     * 实测 355 万元素的扁平数组让 heap 涨 222MB、耗时 141ms,而提取到的
     * 指纹是 0 个(开销换来的信息量为零)。
     *
     * ## 为什么用行为断言而不是内存断言
     *
     * 我第一版断言"heap 增长 < 60MB"。变异验证打脸:把压栈计数改回去之后
     * 测试**依然全绿** —— 因为我为了让测试跑得快把数组从 355 万缩到 50 万,
     * 而那个规模的内存增长恰好落在我自己设的阈值内。内存与耗时断言的阈值
     * 天生要靠猜,猜松了就是空壳。
     *
     * 改用一个由修复**直接导致**的行为差异:
     *
     * - 压栈计数(修复后):预算在压栈阶段耗尽 → 一个指纹都提不到
     * - 不计数(缺陷):5 万个元素全部入栈,随后逐个出栈 → 提取满 64 个
     *
     * 0 vs 64 没有阈值可猜。
     */
    const body = {
      messages: Array.from({ length: 50_000 }, (_u, i) => ({
        signature: `encrypted-blob-${i}-not-real-content`,
      })),
    };
    expect(extractBlobHashes(body)).toEqual([]);
  });

  it("恰好在预算内的宽数组仍然能提取", () => {
    // 边界的另一侧:预算是保护而不是"宽数组一律放弃"。
    const body = {
      messages: Array.from({ length: 200 }, (_u, i) => ({
        signature: `encrypted-blob-${i}-not-real-content`,
      })),
    };
    expect(extractBlobHashes(body)).toHaveLength(64); // 到 MAX_BLOB_VALUES 上限
  });
});

/* ================================================================== *
 * 二、断言太弱:变异改了值而断言只看形态
 * ================================================================== */

describe("冷却时长要断言**确切值**,不只是形态", () => {
  it("NaN 失败计数按 1 算,产出恰好等于基准值", () => {
    /*
     * 原断言只查 `Number.isFinite` —— 而把 `normalizeFails` 的 NaN 兜底从
     * 1 改成 **0** 同样产出有限值(0 会让指数项变成 2^-1 = 0.5,即基准的一半)。
     */
    const exact = cooldownMs({
      kind: "transport", retryAfter: null, consecutiveFails: Number.NaN,
      config: cooldownCfg, now: NOW, jitter: 0,
    });
    expect(exact).toBe(cooldownCfg.transportBaseMs);
  });

  it("抖动用 Math.ceil 向上取整,不是 floor", () => {
    /*
     * 原断言只查"是整数",而 floor 同样产出整数。
     * 2000 * (1 + 0.25 * 0.333) = 2166.5 → ceil 2167,floor 2166。
     */
    expect(cooldownMs({
      kind: "transport", retryAfter: null, consecutiveFails: 1,
      config: cooldownCfg, now: NOW, jitter: 0.333,
    })).toBe(2167);
  });
});

describe("markFailure 返回**生效后**的时刻,不是本次算出的时刻", () => {
  it("短冷却撞上已生效的长冷却时,返回的是那个长的", () => {
    /*
     * 「冷却只延长不缩短」那条测试读的是 `pool.get()`,没读返回值 ——
     * 于是把 `return` 改成"本次算出的值"不会被发现。而调用方
     * (`scheduler.record` 的将来版本、诊断输出)会拿它当"这个 Worker
     * 什么时候恢复"。
     */
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({
      workerId: "w1", kind: "rate_limit", retryAfter: "900", config: cfg, now: NOW, jitter: 0,
    });
    const returned = pool.markFailure({
      workerId: "w1", kind: "transport", retryAfter: null, config: cfg, now: NOW, jitter: 0,
    });
    expect(returned).toBe(NOW + 900_000);
  });
});

describe("snapshot.ready 的边界与 isReady 必须逐点一致", () => {
  it("恰好到期的那一刻两者都说就绪", () => {
    const cfg = config([{ id: "w1" }]);
    const pool = new WorkerPool(cfg);
    pool.markFailure({
      workerId: "w1", kind: "rate_limit", retryAfter: "60", config: cfg, now: NOW, jitter: 0,
    });
    for (const at of [NOW, NOW + 59_999, NOW + 60_000, NOW + 60_001]) {
      expect(pool.snapshot(at)[0]?.ready).toBe(pool.isReady("w1", at));
    }
    expect(pool.snapshot(NOW + 59_999)[0]?.ready).toBe(false);
    expect(pool.snapshot(NOW + 60_000)[0]?.ready).toBe(true);
  });
});

describe("rebind 拒绝不存在的 Worker 时不留垃圾条目", () => {
  it("绑一个不存在的 id 之后,亲和表里不多一条", () => {
    /*
     * `lookupSession` 的 `workerExists` 也会挡住它,所以行为上看不出差别 ——
     * 差别在**留不留垃圾**。上限是 10000,而一个反复重试的客户端可以
     * 持续制造这种条目。
     */
    const cfg = config([{ id: "w1" }]);
    const s = new Scheduler({ jitter: () => 0 });
    s.plan({ config: cfg, now: NOW, sessionHash: null, blobHashes: [] });
    const before = s.snapshot(cfg, NOW).affinity.sessions;
    s.rebind("a".repeat(64), "ghost-worker", NOW);
    expect(s.snapshot(cfg, NOW).affinity.sessions).toBe(before);
  });
});
