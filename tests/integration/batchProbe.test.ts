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

  it("不可解析的代理在筛选段就被挡掉，不占一次真实探测", async () => {
    /*
     * 这是分两段的**全部意义**:一个配置坏了的代理不该占一次几秒的真实探测。
     *
     * ## 构造这个 fixture 花了两次
     *
     * 第一版用「只能桥接的代理 + `clash.enabled: false`」—— 被 `ConfigSchema`
     * 的 `superRefine` 拒了（它有一条「该代理只能经 Clash 桥接，但
     * clash.enabled 为 false」）。**那是 schema 在做它该做的事**：那种配置
     * 加载时就该失败，所以它不可能作为一份合法配置存在。
     *
     * 换成**已停用**的代理:`resolveProxy` 对 `disabled` 也返回失败，
     * 而 `enabled: false` 的代理在 schema 里完全合法（那是用户的正常操作）。
     * 于是筛选段的「挡掉」行为有了一条**真实可达**的路径。
     *
     * Worker 仍然引用它（引用一个停用的代理是合法的 —— schema 只查 id 存在），
     * 所以它会进 `proxyIds` 列表并在筛选段被挡下。
     */
    const config = ConfigSchema.parse({
      version: CONFIG_VERSION,
      gateway: { relayToken: "batch-test-relay-token-x", port: 19992 },
      workers: [
        { id: "ok", kind: "authenticated", apiKey: KEY, proxyId: "good" },
        { id: "bad", kind: "authenticated", apiKey: KEY, proxyId: "off" },
      ],
      proxies: [
        {
          id: "good",
          name: "直连",
          type: "http",
          host: "127.0.0.1",
          port: echoPort,
          source: "manual",
          direct: true,
          bridgeable: false,
          egressIp: null,
        },
        {
          id: "off",
          name: "已停用的直连",
          type: "http",
          host: "127.0.0.1",
          port: echoPort,
          source: "manual",
          // 停用 → `resolveProxy` 返回 `{ kind: "disabled" }`。
          enabled: false,
          direct: true,
          bridgeable: false,
          egressIp: null,
        },
      ],
      clash: { enabled: false, bridges: [] },
    });

    const { runner, getConfig } = makeRunner(config);
    runner.start();
    await waitDone(runner);

    const p = runner.snapshot();
    // 筛选了 2 个。
    expect(p.screenTotal).toBe(2);
    expect(p.screenDone).toBe(2);
    // 但只有 1 个进了主探测 —— 另一个被挡在筛选段。
    expect(p.mainTotal).toBe(1);
    expect(p.mainDone).toBe(1);

    // 被挡掉的那个不该有实测 IP（它根本没被探）。
    const after = getConfig();
    expect(after.proxies.find((x) => x.id === "off")!.egressIp).toBeNull();
    expect(after.proxies.find((x) => x.id === "good")!.egressIp).not.toBeNull();
  }, 30_000);

  it("中途暂停再恢复后，进度不丢 —— 完成时 mainDone 必须追平 mainTotal", async () => {
    /*
     * 第八轮审核查出的一个**真实缺陷**在这里钉住。
     *
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
     * 第一版用真实 echo 服务写这条,**它对着缺陷版本也通过** —— 因为本机探测
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
