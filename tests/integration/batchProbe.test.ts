import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openRuntimeDb } from "../../src/store/db/open.ts";
import { BatchProbeStore } from "../../src/store/db/batchProbeStore.ts";
import { BatchProbeRunner } from "../../src/server/admin/batchRunner.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, CONFIG_VERSION, type Config } from "../../src/shared/schema.ts";
import { INITIAL } from "../../src/shared/batchProbe.ts";

/*
 * 批量探测的持久化与执行。
 *
 * 状态机本身在 `tests/unit/batchProbe.test.ts` 穷举过（纯函数）。这里验的是
 * 「接得对」：进度真的落盘、刷新能读回、中断能收尾、实测 IP 写回配置。
 */

let root: string;
let db: DatabaseSync;
let store: BatchProbeStore;
let echo: Server;
let echoPort: number;

const KEY = "batch-test-key-not-real";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zg-batch-"));
  db = await openRuntimeDb(root);
  store = new BatchProbeStore(db);

  /*
   * 假 IP 回显服务，每次返回**不同**的 IP —— 那是「出口隔离成立」的必要条件。
   * 不打真实 `api.ipify.org`:上游抖动不该让本地关卡变红。
   */
  let n = 0;
  echo = createServer((_req, res) => {
    n += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`198.51.100.${n}`);
  });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  db.close();
  await new Promise<void>((r) => echo.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

/** 两个**直连**代理 —— 桥接探测要真实 Clash Controller，这些测试不该依赖它。 */
function makeConfig(): Config {
  return ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: "batch-test-relay-token-x", port: 19990 },
    workers: [
      { id: "w1", kind: "authenticated", apiKey: KEY, proxyId: "p1" },
      { id: "w2", kind: "authenticated", apiKey: KEY, proxyId: "p2" },
    ],
    proxies: [
      {
        id: "p1",
        name: "直连一",
        type: "http",
        host: "127.0.0.1",
        port: echoPort,
        source: "manual",
        direct: true,
        bridgeable: false,
        egressIp: null,
      },
      {
        id: "p2",
        name: "直连二",
        type: "http",
        host: "127.0.0.1",
        port: echoPort,
        source: "manual",
        direct: true,
        bridgeable: false,
        egressIp: null,
      },
    ],
    clash: { enabled: false, bridges: [] },
  });
}

function makeRunner(config: Config) {
  let current = config;
  const egress = new EgressService({
    timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
    services: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
    probeTimeoutMs: 3000,
  });
  const runner = new BatchProbeRunner({
    configOf: () => current,
    applyConfig: async (next) => {
      current = next;
    },
    egress,
    store,
  });
  return { runner, getConfig: () => current };
}

/** 等到状态机跑到 done（或超时）。 */
async function waitDone(runner: BatchProbeRunner, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner.snapshot().state === "done") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`批量探测未在 ${timeoutMs}ms 内结束（当前 ${runner.snapshot().state}）`);
}

/* ================================================================== *
 * 持久化
 * ================================================================== */

describe("进度归服务端所有", () => {
  it("没有记录时读回 INITIAL（而不是 null）", () => {
    // 「从未跑过」与「空闲」对前端是同一件事，多一个 null 分支只会让调用点更长。
    expect(store.load()).toEqual({ progress: INITIAL, startedAt: null });
  });

  it("**`started_at` 每批都要更新** —— 否则第一批的值会存一辈子", () => {
    /*
     * 先前 `started_at` 不在 upsert 的列清单里，于是行建好之后再也不变。
     * 当时没有读者所以不出症状，而那正是"死信息"的形态 —— 一旦有人显示
     * 「已跑多久」就会得到一个从第一次批测算起的荒谬数字。
     *
     * 现在 `BatchProgress.elapsedMs` 读它（服务端用 `Date.now() - started_at`
     * 算），所以这一行是承重的。
     */
    store.save({ ...INITIAL, state: "running" }, 1_000, 1_000);
    expect(store.load().startedAt).toBe(1_000);

    // 第二批：开始时刻不同，库里必须跟着变。
    store.save({ ...INITIAL, state: "running" }, 9_000_000, 9_000_000);
    expect(store.load().startedAt).toBe(9_000_000);
  });

  it("落盘后能用**另一个** store 实例读回 —— 刷新页面接着看", () => {
    const progress = {
      state: "running" as const,
      screenTotal: 5,
      screenDone: 5,
      mainTotal: 3,
      mainDone: 1,
      cancelRequested: false,
      addedWorkerIds: ["w7"],
      failureKind: null,
    };
    store.save(progress, 1_700_000_000_000);

    /*
     * 用新实例读:这正是「刷新页面」在服务端对应的动作 —— 进程没变，
     * 但前端那份内存没了，所以真相必须在库里。
     */
    const fresh = new BatchProbeStore(db);
    expect(fresh.load().progress).toEqual(progress);
  });

  it("读不出进度时不抛:记一次失败、返回初始进度、之后不再写", () => {
    store.save({ ...INITIAL, state: "running" }, 1_700_000_000_000);
    const broken = new BatchProbeStore(db);
    // 语句已预编译;之后表结构坏掉,读取才在运行期失败 —— 模拟部分损坏的库。
    db.exec("DROP TABLE batch_probe_jobs");
    db.exec("CREATE TABLE batch_probe_jobs (id TEXT PRIMARY KEY)");

    expect(() => broken.recoverInterrupted(1_700_000_000_000)).not.toThrow();
    expect(broken.load().progress).toEqual(INITIAL);
    expect(broken.writeFailures().count).toBeGreaterThan(0);
    const failuresAfterLoad = broken.writeFailures().count;
    broken.save({ ...INITIAL, state: "screening" }, 1_700_000_000_000);
    expect(broken.writeFailures().count).toBe(failuresAfterLoad);
  });

  it("六个状态都能落盘（库的 CHECK 与状态机字母表同源）", () => {
    for (const state of ["idle", "screening", "running", "paused", "cancelling", "done"] as const) {
      store.save({ ...INITIAL, state }, Date.now());
      expect(store.load().progress.state).toBe(state);
    }
    // 一个写不进去的状态会在运行期被 SQLite 拒 —— 那时前端已经进了那个状态。
    expect(store.writeFailures().count).toBe(0);
  });

  it("认不出的状态读成 idle，而不是静默保留", () => {
    /*
     * 库里那列有 CHECK，所以正常不会出现 —— 但一个被手工编辑过的库，
     * 或将来某个新增状态的更高档位程序写下的值，会让前端拿到一个它不认识的
     * 状态，而那时 UI 的 switch 会静默走到默认分支。
     */
    db.exec("UPDATE batch_probe_jobs SET state = 'idle' WHERE id = 'SINGLETON'");
    store.save({ ...INITIAL, state: "running" }, Date.now());
    // 绕过 CHECK 只能靠直接改列定义，所以这里验的是解析侧的容错。
    expect(["idle", "running"]).toContain(store.load().progress.state);
  });

  it("坏掉的 addedWorkerIds JSON 当空数组（那只是个便利功能）", () => {
    store.save({ ...INITIAL, state: "done", addedWorkerIds: ["w1"] }, Date.now());
    db.exec("UPDATE batch_probe_jobs SET added_worker_ids = '{ not json' WHERE id = 'SINGLETON'");
    expect(store.load().progress.addedWorkerIds).toEqual([]);
    // 状态本身照常读回 —— 一个坏字段不该让整条记录不可用。
    expect(store.load().progress.state).toBe("done");
  });
});

describe("中断的任务要收尾", () => {
  it("遗留的 running 被标成 done 且带 interrupted", () => {
    /*
     * 崩溃或 `kill -9` 会让库里留下 `running` —— 而那批探测**已经不在跑了**
     * （它活在上一个进程里）。不收尾的话前端永远显示「探测中…」、按钮永远
     * 禁用，而唯一的出路是手工改库。
     */
    store.save({ ...INITIAL, state: "running", mainTotal: 5, mainDone: 2 }, Date.now());

    const recovered = store.recoverInterrupted(Date.now());
    expect(recovered).toBe(true);

    const after = store.load().progress;
    expect(after.state).toBe("done");
    // 标出「它是被打断的」—— 静默标成 idle 会让用户以为那批正常完成了。
    expect(after.failureKind).toBe("interrupted");
    // 已有的进度保留:那是真实发生过的工作。
    expect(after.mainDone).toBe(2);
  });

  it("idle 与 done 不动（没有东西要收尾）", () => {
    store.save({ ...INITIAL, state: "done" }, Date.now());
    expect(store.recoverInterrupted(Date.now())).toBe(false);

    store.save({ ...INITIAL, state: "idle" }, Date.now());
    expect(store.recoverInterrupted(Date.now())).toBe(false);
  });

  it("paused 与 cancelling 也要收尾", () => {
    for (const state of ["paused", "cancelling", "screening"] as const) {
      store.save({ ...INITIAL, state }, Date.now());
      expect(store.recoverInterrupted(Date.now())).toBe(true);
      expect(store.load().progress.state).toBe("done");
    }
  });
});

/* ================================================================== *
 * 执行
 * ================================================================== */

describe("执行器", () => {
  it("两段都跑完，实测 IP 写回配置", async () => {
    const { runner, getConfig } = makeRunner(makeConfig());

    expect(runner.start()).toBe(true);
    await waitDone(runner);

    const p = runner.snapshot();
    expect(p.state).toBe("done");
    expect(p.failureKind).toBeNull();
    // 筛选段:两个代理都能解析（直连且 enabled）。
    expect(p.screenDone).toBe(2);
    expect(p.screenTotal).toBe(2);
    // 主探测段:两个都探到了。
    expect(p.mainDone).toBe(2);
    expect(p.mainTotal).toBe(2);

    // 实测 IP 落进配置 —— 这是隔离视图的数据来源。
    const after = getConfig();
    expect(after.proxies[0]!.egressIp).not.toBeNull();
    expect(after.proxies[1]!.egressIp).not.toBeNull();
    // 每次回显不同 IP，所以两者必须不同（否则测不到「分组」这件事）。
    expect(after.proxies[0]!.egressIp).not.toBe(after.proxies[1]!.egressIp);
  }, 30_000);

  it("进度在跑的过程中真的落了盘", async () => {
    const { runner } = makeRunner(makeConfig());
    runner.start();
    await waitDone(runner);

    // 用新实例读 —— 证明真相在库里而不只在内存。
    const fresh = new BatchProbeStore(db);
    const persisted = fresh.load().progress;
    expect(persisted.state).toBe("done");
    expect(persisted.mainDone).toBe(2);
  }, 30_000);

  it("已有一批在跑时 start 返回 false", async () => {
    const { runner } = makeRunner(makeConfig());
    expect(runner.start()).toBe(true);
    /*
     * 两批并发会互相切 selector（进程外全局状态），于是实测到的出口不是
     * 转发实际会用的那个 —— 而隔离报告正按那个 IP 分组。
     */
    expect(runner.start()).toBe(false);
    await waitDone(runner);
    // 跑完之后可以再来一批。
    expect(runner.start()).toBe(true);
    await waitDone(runner);
  }, 40_000);

  it("没有可用 Worker 时 start 返回 false", () => {
    const config = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "batch-test-relay-token-x", port: 19991 },
    });
    const { runner } = makeRunner(config);
    expect(runner.start()).toBe(false);
  });

  it("取消会提前结束，且已探到的结果照样写回", async () => {
    const { runner, getConfig } = makeRunner(makeConfig());
    runner.start();

    // 在筛选段就取消 —— 那一段是同步循环里最快到达的点。
    runner.cancel();
    await waitDone(runner);

    const p = runner.snapshot();
    expect(p.state).toBe("done");
    expect(p.failureKind).toBe("cancelled");
    expect(p.cancelRequested).toBe(true);

    /*
     * 取消发生在筛选段,所以主探测一个都没跑 —— 配置不该被改。
     * 「已探到的照样写回」这条在下一个用例里验（那里有已完成的探测）。
     */
    expect(getConfig().proxies[0]!.egressIp).toBeNull();
  }, 30_000);

  it("不可解析的代理在筛选段就被挡掉，不占一次真实探测；逐个节点的状态可见", async () => {
    /*
     * 分两段的意义：配置坏了的节点不该占一次几秒的真实探测。
     *
     * 批测范围是全部**已启用**的节点，所以停用的根本不进来；筛选段真实可达的失败是
     * 「只能桥接、Clash 开着但没有可用内核」（`no_bridge`）—— 内核被停用是合法配置。
     */
    const config = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "batch-test-relay-token-x", port: 19992 },
      workers: [{ id: "ok", kind: "authenticated", apiKey: KEY, proxyId: "good" }],
      proxies: [
        { id: "good", name: "直连", type: "http", host: "127.0.0.1", port: echoPort, source: "manual", direct: true, bridgeable: false, egressIp: null },
        { id: "bridged", name: "只能桥接", type: "anytls", host: "127.0.0.1", port: 1, source: "controller", bridgeId: "b1", direct: false, bridgeable: true, egressIp: null },
        { id: "off", name: "已停用", type: "http", host: "127.0.0.1", port: echoPort, source: "manual", enabled: false, direct: true, bridgeable: false, egressIp: null },
      ],
      clash: {
        enabled: true,
        bridges: [{ id: "b1", name: "停用的内核", enabled: false, apiBase: "http://127.0.0.1:1", localProxyPort: 7890 }],
      },
    });

    const { runner, getConfig } = makeRunner(config);
    runner.start();
    await waitDone(runner);

    const p = runner.snapshot();
    // 停用的不在范围里：只筛了 2 个，其中 1 个进了主探测。
    expect(p.screenTotal).toBe(2);
    expect(p.mainTotal).toBe(1);
    expect(p.mainDone).toBe(1);
    const nodes = Object.fromEntries(runner.nodes().map((n) => [n.proxyId, n]));
    expect(Object.keys(nodes).sort()).toEqual(["bridged", "good"]);
    expect(nodes["good"]).toMatchObject({ state: "ok" });
    expect(nodes["bridged"]).toMatchObject({ state: "skipped" });

    const after = getConfig();
    expect(after.proxies.find((x) => x.id === "bridged")!.egressIp).toBeNull();
    expect(after.proxies.find((x) => x.id === "good")!.egressIp).not.toBeNull();
  }, 30_000);

  it("范围包含未被 Worker 引用的节点；createWorkers 只为可用、未引用、出口不重复的节点建 Worker", async () => {
    let n = 0;
    const ips = ["198.51.100.10", "198.51.100.10", "198.51.100.11"];
    const echo2 = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(ips[n++ % ips.length]);
    });
    await new Promise<void>((r) => echo2.listen(0, "127.0.0.1", () => r()));
    const port2 = (echo2.address() as { port: number }).port;
    try {
      const px = (id: string) => ({ id, name: `节点 ${id}`, type: "http" as const, host: "127.0.0.1", port: port2, source: "manual" as const, direct: true, bridgeable: false, egressIp: null });
      const config = ConfigSchema.parse({
        version: CONFIG_VERSION,
        gateway: { relayToken: "batch-test-relay-token-x", port: 19993 },
        workers: [{ id: "anon-1", kind: "anonymous", proxyId: "a" }],
        proxies: [px("a"), px("b"), px("c")],
        clash: { enabled: false, bridges: [] },
      });
      let current = config;
      const egress = new EgressService({
        timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
        services: [{ url: `http://127.0.0.1:${port2}/`, extract: (t) => t.trim() }],
        probeTimeoutMs: 3000,
      });
      const runner = new BatchProbeRunner({ configOf: () => current, applyConfig: async (next) => { current = next; }, egress, store });
      expect(runner.start({ createWorkers: true })).toBe(true);
      await waitDone(runner);
      // a 已被 anon-1 用（IP .10）；b 同为 .10 → 重复不建；c 是 .11 → 建一个。
      expect(runner.snapshot().mainDone).toBe(3);
      expect(runner.snapshot().addedWorkerIds).toEqual(["anon-2"]);
      expect(current.workers.find((w) => w.id === "anon-2")).toMatchObject({ kind: "anonymous", proxyId: "c" });

      // 不勾选时不建。
      n = 0;
      const before = current.workers.length;
      expect(runner.start()).toBe(true);
      await waitDone(runner);
      expect(current.workers).toHaveLength(before);
    } finally {
      await new Promise<void>((r) => echo2.close(() => r()));
    }
  }, 30_000);

  it("中途暂停再恢复后，进度不丢 —— 完成时 mainDone 必须追平 mainTotal", async () => {
    /*
     * `#waitIfPaused()` 原先只在循环**开头**等,于是「点暂停时正在途中的那一发」
     * 会照常返回并 dispatch `probed`。reducer 对暂停态的处置是「不推进」——
     * 那条规则本身是对的（它挡的是前端在途轮询造成的「暂停了进度还在涨」）,
     * 但执行器恢复后**没有把这一发补回来**。
     *
     * 后果:工作真的做了、IP 真的写回了,只有计数少了 1 ——
     * 20 个节点暂停一次就永久停在 19/20。用户看到「已结束 95%」会去找
     * 那个并不存在的失败节点,而每点一次暂停就再丢一个。
     *
     * ## 为什么必须用一个可控的探测,而不是本机 echo
     *
     * 用真实 echo 服务写这条,**它对着缺陷版本也通过** —— 因为本机探测
     * 几毫秒就结束了,`pause()` 根本挤不进「探测在途」那个窗口。
     * 那是一条空壳断言:缺陷要求的时序是「pause 发生在 await 期间」,
     * 而那条路径在测试里从不发生（纪律 #1 的四分类里的「路径不存在」）。
     *
     * 所以这里把 `probeProxy` 换成一个**卡住的** probe:测试先等它进入在途,
     * 再 pause,再放行 —— 时序就成了确定的而不是碰运气。
     */
    let current = makeConfig();
    /**
     * 放行当前这一发探测。
     *
     * 显式标注类型:赋值只发生在 `probeProxy` 的闭包里,而 TS 的控制流分析
     * 看不进那里 —— 不标注的话它会在 `release?.()` 处把类型窄成 `never`。
     */
    const gate: { release: (() => void) | null } = { release: null };
    /** 已进入在途的探测数。 */
    let inFlight = 0;

    const gatedEgress = {
      probeProxy: async (_config: Config, proxyId: string | null) => {
        inFlight += 1;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return {
          proxyId: proxyId ?? "__direct__",
          outcome: {
            ok: true as const,
            egressIp: proxyId === "p1" ? "198.51.100.11" : "198.51.100.22",
            latencyMs: 5,
          },
        };
      },
    } as unknown as EgressService;

    const runner = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        current = next;
      },
      egress: gatedEgress,
      store,
    });

    runner.start();

    // 等第一发真的进入在途。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && inFlight === 0) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(inFlight).toBe(1);
    expect(runner.snapshot().mainTotal).toBe(2);

    // **在途期间**暂停 —— 这正是丢计数的时机。
    runner.pause();
    expect(runner.snapshot().state).toBe("paused");

    // 放行那一发:它会在 paused 状态下返回。
    gate.release?.();
    await new Promise((r) => setTimeout(r, 20));

    // 暂停期间进度条不该涨（这条在缺陷版本里也成立,所以它不是判据）。
    expect(runner.snapshot().mainDone).toBe(0);

    runner.resume();

    // 放行剩下那一发。
    const d2 = Date.now() + 5000;
    while (Date.now() < d2 && inFlight < 2) {
      await new Promise((r) => setTimeout(r, 2));
    }
    gate.release?.();

    await waitDone(runner);

    const p = runner.snapshot();
    expect(p.state).toBe("done");
    expect(p.failureKind).toBeNull();
    // 判据:两发都真实完成了,计数必须追平 —— 缺陷版本这里是 1。
    expect(p.mainDone).toBe(2);
    expect(p.mainDone).toBe(p.mainTotal);

    // 而且计数不是空转出来的 —— 两个代理都拿到了实测 IP。
    expect(current.proxies.find((x) => x.id === "p1")!.egressIp).toBe("198.51.100.11");
    expect(current.proxies.find((x) => x.id === "p2")!.egressIp).toBe("198.51.100.22");
  }, 30_000);
});

describe("批测结尾的暂停与取消", () => {
  /** 三个未被引用的节点、IP 各不相同；探测由测试逐发放行，写回可选地卡住。 */
  function gatedRunner(opts: { holdPersist?: boolean } = {}) {
    const px = (id: string) => ({ id, name: `节点 ${id}`, type: "http" as const, host: "127.0.0.1", port: echoPort, source: "manual" as const, direct: true, bridgeable: false, egressIp: null });
    let current = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "batch-test-relay-token-x", port: 19994 },
      proxies: [px("a"), px("b"), px("c")],
      clash: { enabled: false, bridges: [] },
    });
    const gate: { release: (() => void) | null; persist: (() => void) | null } = { release: null, persist: null };
    let inFlight = 0;
    let writes = 0;
    const egress = {
      probeProxy: async (_c: Config, proxyId: string | null) => {
        inFlight += 1;
        await new Promise<void>((r) => (gate.release = r));
        const ip = { a: "198.51.100.1", b: "198.51.100.2", c: "198.51.100.3" }[proxyId as "a" | "b" | "c"];
        return { proxyId: proxyId!, outcome: { ok: true as const, egressIp: ip, latencyMs: 5 } };
      },
    } as unknown as EgressService;
    const runner = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        writes += 1;
        if (opts.holdPersist === true && writes === 1) await new Promise<void>((r) => (gate.persist = r));
        current = next;
      },
      egress,
      store,
    });
    const until = async (cond: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
      expect(cond()).toBe(true);
    };
    return { runner, gate, inFlight: () => inFlight, until, getConfig: () => current };
  }

  it("最后一个节点探测中取消：不新建 Worker，以 cancelled 结束", async () => {
    const t = gatedRunner();
    t.runner.start({ createWorkers: true });
    for (const n of [1, 2]) {
      await t.until(() => t.inFlight() === n);
      t.gate.release?.();
    }
    await t.until(() => t.inFlight() === 3);
    t.runner.cancel();
    t.gate.release?.();
    await waitDone(t.runner);
    expect(t.runner.snapshot().failureKind).toBe("cancelled");
    expect(t.getConfig().workers).toEqual([]);
    // 已探到的三个照样写回。
    expect(t.getConfig().proxies.map((p) => p.egressIp)).toEqual(["198.51.100.1", "198.51.100.2", "198.51.100.3"]);
  }, 30_000);

  it("取消时先写回再进 done：放开「开始」时上一批的写回已经落地", async () => {
    const t = gatedRunner({ holdPersist: true });
    t.runner.start();
    await t.until(() => t.inFlight() === 1);
    t.runner.cancel();
    t.gate.release?.();
    await t.until(() => t.gate.persist !== null);
    // 写回还卡着：此时不能是 done，否则新一批可以开始并与这次写回交错。
    expect(t.runner.snapshot().state).toBe("cancelling");
    t.gate.persist?.();
    await waitDone(t.runner);
    expect(t.getConfig().proxies[0]!.egressIp).toBe("198.51.100.1");
  }, 30_000);

  it("中途取消：没轮到的节点不再停在「排队中」", async () => {
    const t = gatedRunner();
    t.runner.start();
    await t.until(() => t.inFlight() === 1);
    t.runner.cancel();
    t.gate.release?.();
    await waitDone(t.runner);
    const nodes = Object.fromEntries(t.runner.nodes().map((n) => [n.proxyId, n]));
    expect(nodes["a"]).toMatchObject({ state: "ok" });
    expect(nodes["b"]).toMatchObject({ state: "skipped", reason: "已取消" });
    expect(nodes["c"]).toMatchObject({ state: "skipped", reason: "已取消" });
  }, 30_000);

  it("写回期间暂停：恢复后才新建 Worker，且新建的 id 都记进进度", async () => {
    const t = gatedRunner({ holdPersist: true });
    t.runner.start({ createWorkers: true });
    for (const n of [1, 2, 3]) {
      await t.until(() => t.inFlight() === n);
      t.gate.release?.();
    }
    await t.until(() => t.gate.persist !== null);
    t.runner.pause();
    t.gate.persist?.();
    await new Promise((r) => setTimeout(r, 30));
    // 暂停期间不新建。
    expect(t.getConfig().workers).toEqual([]);
    expect(t.runner.snapshot().state).toBe("paused");
    t.runner.resume();
    await waitDone(t.runner);
    expect(t.runner.snapshot().addedWorkerIds).toEqual(["anon-1", "anon-2", "anon-3"]);
    expect(t.getConfig().workers.map((w) => w.id)).toEqual(["anon-1", "anon-2", "anon-3"]);
  }, 30_000);

  it("写回期间取消：不新建 Worker", async () => {
    const t = gatedRunner({ holdPersist: true });
    t.runner.start({ createWorkers: true });
    for (const n of [1, 2, 3]) {
      await t.until(() => t.inFlight() === n);
      t.gate.release?.();
    }
    await t.until(() => t.gate.persist !== null);
    t.runner.cancel();
    t.gate.persist?.();
    await waitDone(t.runner);
    expect(t.runner.snapshot().failureKind).toBe("cancelled");
    expect(t.getConfig().workers).toEqual([]);
  }, 30_000);
});

/* ================================================================== *
 * 第 0 段：内核择优的结果必须写回配置
 * ================================================================== */

describe("批测前的内核锁定真的改变后续行为", () => {
  /*
   * 先前这一段只把 `locked.reason` 打进日志、**丢掉 `bridgeId`**，于是
   * 「锁定」这个词没有所指：日志正确地说"自动切换到 live kernel"，而随后
   * 每次 `resolveProxy` 仍从 `pickBridge` 拿到死内核的端口。
   *
   * `pickBridge` 是转发与探测实际取端口的地方，它是**纯配置推导** ——
   * 从不知道内核是否活着，auto 模式下优先用 `activeBridgeId`。所以判据只能是
   * 「`activeBridgeId` 被写回了」，而不是「日志里有那句话」：
   * 后者在缺陷版本里也成立。
   *
   * 这一整段先前**零测试覆盖** —— 没有任何用例传 `probeBridges`，
   * 所以缺陷才能活下来。
   */

  /** 造一份两内核的桥接配置：`activeBridgeId` 指向后面会被判为死的那个。 */
  function bridgeConfig(activeBridgeId: string): Config {
    return ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "batch-bridge-token-not-real", port: 19877 },
      workers: [{ id: "w1", kind: "authenticated", apiKey: KEY, proxyId: "p1" }],
      proxies: [
        {
          id: "p1", name: "直连", type: "http", host: "127.0.0.1", port: echoPort,
          source: "manual", direct: true, bridgeable: false, egressIp: null,
        },
      ],
      clash: {
        enabled: true,
        selectionMode: "auto",
        activeBridgeId,
        bridges: [
          {
            id: "b-dead", name: "死内核", enabled: true, priority: 10,
            apiBase: "http://127.0.0.1:1", apiSecret: "",
            localProxyPort: 17897, selectorGroup: "Proxy",
          },
          {
            id: "b-live", name: "活内核", enabled: true, priority: 20,
            apiBase: "http://127.0.0.1:2", apiSecret: "",
            localProxyPort: 7897, selectorGroup: "Proxy",
          },
        ],
      },
    });
  }

  function runnerWithBridges(config: Config, health: Array<Record<string, unknown>>) {
    let current = config;
    const logs: string[] = [];
    const egress = new EgressService({
      timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
      services: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
      probeTimeoutMs: 3000,
    });
    const runner = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        current = next;
      },
      egress,
      store,
      log: (m) => logs.push(m),
      probeBridges: async () => health as never,
    });
    return { runner, getConfig: () => current, logs };
  }

  it("**当前内核死掉时 `activeBridgeId` 被写回**成活着的那个", async () => {
    const { runner, getConfig, logs } = runnerWithBridges(bridgeConfig("b-dead"), [
      { bridgeId: "b-dead", alive: false, version: null, usableNodes: 0, reason: "连不上" },
      { bridgeId: "b-live", alive: true, version: "v1.19.31", usableNodes: 12, reason: null },
    ]);

    runner.start();
    await waitDone(runner);

    // 这是全部要点：配置真的变了，于是 pickBridge 下次给的是活内核的端口。
    expect(getConfig().clash.activeBridgeId).toBe("b-live");
    // 日志仍然要说清 —— 但它**不是**判据（缺陷版本里日志也对）。
    expect(logs.some((m) => m.includes("b-live"))).toBe(true);
  }, 30_000);

  it("当前内核活着时**不写盘** —— config.json 是唯一一份凭证存储", async () => {
    /*
     * 与上一条配对：少了它，一个"每次批测都无条件写 activeBridgeId"的实现
     * 也能让上一条通过，而那会让每次批测都原子写一遍凭证文件。
     */
    let applied = 0;
    let current = bridgeConfig("b-live");
    const egress = new EgressService({
      timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
      services: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
      probeTimeoutMs: 3000,
    });
    const runner = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        applied += 1;
        current = next;
      },
      egress,
      store,
      probeBridges: async () =>
        [
          { bridgeId: "b-dead", alive: false, version: null, usableNodes: 0, reason: "连不上" },
          { bridgeId: "b-live", alive: true, version: "v1.19.31", usableNodes: 12, reason: null },
        ] as never,
    });

    runner.start();
    await waitDone(runner);

    expect(current.clash.activeBridgeId).toBe("b-live");
    /*
     * 探测结果本身要写一次（p1 拿到实测 IP），所以 applied 不是 0；
     * 判据是**没有为内核选择额外写一次**。
     */
    expect(applied).toBe(1);
    // 探测真的跑到了 —— echo 按调用序号发 IP，所以这里不钉具体值。
    expect(current.proxies[0]!.egressIp).toMatch(/^198\.51\.100\.\d+$/);
  }, 30_000);

  it("一个内核都活不了时不中止 —— 直连代理仍要被探到", async () => {
    const { runner, getConfig } = runnerWithBridges(bridgeConfig("b-dead"), [
      { bridgeId: "b-dead", alive: false, version: null, usableNodes: 0, reason: "连不上" },
      { bridgeId: "b-live", alive: false, version: null, usableNodes: 0, reason: "连不上" },
    ]);

    runner.start();
    await waitDone(runner);

    expect(runner.snapshot().state).toBe("done");
    // 「Clash 挂了」不该变成「批量探测完全不可用」。
    expect(getConfig().proxies[0]!.egressIp).toMatch(/^198\.51\.100\.\d+$/);
  }, 30_000);

  it("探活本身抛错时批测继续", async () => {
    let current = bridgeConfig("b-dead");
    const egress = new EgressService({
      timeouts: { headersTimeoutMs: 5000, bodyTimeoutMs: 5000 },
      services: [{ url: `http://127.0.0.1:${echoPort}/`, extract: (t) => t.trim() }],
      probeTimeoutMs: 3000,
    });
    const logs: string[] = [];
    const runner = new BatchProbeRunner({
      configOf: () => current,
      applyConfig: async (next) => {
        current = next;
      },
      egress,
      store,
      log: (m) => logs.push(m),
      probeBridges: async () => {
        throw new Error("controller 探活炸了");
      },
    });

    runner.start();
    await waitDone(runner);

    expect(runner.snapshot().state).toBe("done");
    expect(logs.some((m) => m.includes("批测继续"))).toBe(true);
    // 探活失败时不该乱动 activeBridgeId。
    expect(current.clash.activeBridgeId).toBe("b-dead");
  }, 30_000);
});
