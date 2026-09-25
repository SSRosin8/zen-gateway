import type { Config } from "../../shared/schema.ts";
import { reduce, type BatchProgress } from "../../shared/batchProbe.ts";
import { INITIAL } from "../../shared/batchProbe.ts";
import type { BatchProbeStore } from "../../store/db/batchProbeStore.ts";
import type { EgressService } from "../../core/proxy/egress.ts";
import { applyProbeResult } from "../../core/proxy/egress.ts";
import { resolveProxy } from "../../core/proxy/pool.ts";
import { isUsable } from "../../core/routing/workerPool.ts";
import { safeErrorMessage } from "../../shared/redact.ts";

/**
 * 批量探测的执行器 —— 把纯 reducer 接到真实探测上。
 *
 * ## 分工
 *
 * - `shared/batchProbe.ts`：状态机（纯函数，穷举可测）
 * - `store/db/batchProbeStore.ts`：进度持久化（刷新页面能接着看）
 * - **本文件**：只负责「按状态机的指示去跑，并把结果喂回去」
 *
 * 三者分开的理由与 `routing/` 那四块同源：判断能被穷举测试，而这一层只需
 * 验证「接得对」。
 *
 * ## 两段是什么
 *
 * 1. **筛选**：`resolveProxy` 能不能解析出一条出口路径 —— 纯本地判断，很快。
 *    一个配置坏了的代理（指向不存在的内核、Clash 没开）不该占一次真实探测。
 * 2. **主探测**：对通过筛选的逐个实测公网 IP —— 真发网络请求，桥接还要切
 *    selector（串行化），所以这一段可能几十秒。
 *
 * 两段**分开显示进度**，不合成一个假百分比（见状态机的文件头）。
 *
 * ## 为什么执行在后台、不 await
 *
 * `POST /api/batch-probe` 立刻返回，进度靠轮询 `GET` 拿。一个几十秒的
 * HTTP 请求会被各种中间层掐断，而那时探测其实还在跑 —— 前端拿到一个错误
 * 而后台状态仍是 running，两边不一致。
 */

export type BatchRunnerDeps = {
  readonly configOf: () => Config;
  readonly applyConfig: (next: Config) => Promise<void>;
  readonly egress: EgressService;
  readonly store: BatchProbeStore;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
};

export class BatchProbeRunner {
  #deps: BatchRunnerDeps;
  #progress: BatchProgress;
  #startedAt: number | null;
  /**
   * 正在跑的那一轮。
   *
   * 用它判断「是否已有一批在跑」而不是只看 `#progress.state`：状态落盘是异步的,
   * 而两个几乎同时到达的 start 请求都会先读到 `idle`。持有一个 Promise 引用
   * 是进程内最直接的互斥。
   */
  #running: Promise<void> | null = null;
  /**
   * 暂停的等待点。`resume` 时 resolve 它。
   *
   * 用 Promise 而不是轮询一个布尔:轮询要选一个间隔,而那个间隔就是「点了继续
   * 之后多久才真的继续」的延迟。
   */
  #resumeSignal: (() => void) | null = null;

  constructor(deps: BatchRunnerDeps) {
    this.#deps = deps;
    const loaded = deps.store.load();
    this.#progress = loaded.progress;
    this.#startedAt = loaded.startedAt;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** 当前进度。前端轮询这个。 */
  snapshot(): BatchProgress {
    return this.#progress;
  }

  #dispatch(event: Parameters<typeof reduce>[1]): void {
    const next = reduce(this.#progress, event);
    if (next === this.#progress) return; // 不合法的转移，不写盘
    this.#progress = next;
    this.#deps.store.save(next, this.#now(), this.#startedAt ?? this.#now());
  }

  /**
   * 开始一批。
   *
   * 返回 false 表示「已有一批在跑」—— 调用方据此回 409，而**不是**静默排队:
   * 两批并发会互相切 selector（进程外全局状态），于是实测到的出口不是转发
   * 实际会用的那个，而隔离报告正按那个 IP 分组。
   */
  start(): boolean {
    if (this.#running !== null) return false;

    const config = this.#deps.configOf();
    /*
     * 只探**在用的**出口 —— 探一个没人用的代理没有诊断价值。
     *
     * 判据用 `isUsable` 而不是手写一份 `enabled && apiKey.trim() !== ""`:
     * `POST /api/probe` 用的就是它（`routes/admin.ts`）,两处必须同源。
     * 这里先前是手写的第二份 —— 今天两者行为相同,但 `isUsable` 的判据
     * （看 key 而不看 kind）是一个**记录在案的决定**,它变的时候手写那份不会跟着变。
     * 分叉方向具体:批量探测会去探调度器永远不会用的节点,
     * 而隔离报告正是拿两边的结果拼出来的。第八轮审核查出（纪律 #4）。
     */
    const proxyIds = [...new Set(config.workers.filter(isUsable).map((w) => w.proxyId))];
    if (proxyIds.length === 0) return false;

    this.#startedAt = this.#now();
    this.#progress = INITIAL;
    this.#dispatch({ type: "start", screenTotal: proxyIds.length });

    this.#running = this.#run(proxyIds)
      .catch((err) => {
        this.#deps.log?.(`批量探测异常: ${safeErrorMessage(err)}`);
        this.#dispatch({ type: "finished", failureKind: "internal" });
      })
      .finally(() => {
        this.#running = null;
        this.#resumeSignal = null;
      });

    return true;
  }

  pause(): void {
    this.#dispatch({ type: "pause" });
  }

  resume(): void {
    const before = this.#progress.state;
    this.#dispatch({ type: "resume" });
    // 只有真的从 paused 转出去才放行等待点。
    if (before === "paused" && this.#progress.state === "running") {
      this.#resumeSignal?.();
      this.#resumeSignal = null;
    }
  }

  /**
   * 请求取消。
   *
   * 进 `cancelling` 而不是立刻 `done`：在途的那个探测还在跑（桥接探测可能
   * 几秒），而它会切 selector。立刻放开按钮会让用户启动第二批，
   * 两批互相换出口。真正的 `done` 由 `#run` 的循环发现取消标记后给出。
   */
  cancel(): void {
    this.#dispatch({ type: "cancel" });
    // 暂停中取消:要先唤醒等待点，否则循环永远醒不过来。
    this.#resumeSignal?.();
    this.#resumeSignal = null;
  }

  /** 暂停时在这里等。取消也会唤醒它（然后循环会看到 cancelRequested）。 */
  async #waitIfPaused(): Promise<void> {
    if (this.#progress.state !== "paused") return;
    await new Promise<void>((resolve) => {
      this.#resumeSignal = resolve;
    });
  }

  async #run(proxyIds: Array<string | null>): Promise<void> {
    const config = this.#deps.configOf();

    /* ---- 第一段：筛选（纯本地，很快） ---- */
    const passed: Array<string | null> = [];
    for (const proxyId of proxyIds) {
      if (this.#progress.cancelRequested) {
        this.#dispatch({ type: "finished", failureKind: "cancelled" });
        return;
      }
      /*
       * 筛选判据:`resolveProxy` 能否解析出一条出口路径。
       *
       * 这是纯本地判断(配置是否自洽、Clash 是否启用、协议能否直连或桥接),
       * 不发任何请求 —— 所以它快,而这正是分两段的意义:一个配置坏了的代理
       * 不该占一次几秒的真实探测。
       *
       * 复用 `resolveProxy` 而**不是**另写一份判断:两份必然分叉,而分叉后
       * 「筛选说能用而主探测说不能」会让用户看到一批莫名失败的节点。
       */
      const resolved = resolveProxy(config, proxyId);
      if (resolved.ok) passed.push(proxyId);
      this.#dispatch({ type: "screened" });
    }

    this.#dispatch({ type: "screenDone", mainTotal: passed.length });

    /* ---- 第二段：主探测（真发请求） ---- */
    const outcomes = new Map<string, Awaited<ReturnType<EgressService["probeProxy"]>>["outcome"]>();

    for (const proxyId of passed) {
      await this.#waitIfPaused();

      if (this.#progress.cancelRequested) {
        this.#dispatch({ type: "finished", failureKind: "cancelled" });
        // 已经探到的照样写回 —— 那些是真实测量，丢掉它们没有道理。
        await this.#persist(outcomes);
        return;
      }

      /*
       * **逐个串行**，不并发。
       *
       * `probeAll` 有并发参数，但这里刻意不用:进度要一个一个报（并发下
       * 「3/10」这个数字会跳），而桥接探测本来就被 selector 锁串行化了。
       * 直连代理确实可以并发，但为此让进度变得不可预测不值得。
       */
      const result = await this.#deps.egress.probeProxy(config, proxyId);
      outcomes.set(result.proxyId, result.outcome);

      /*
       * 暂停检查要在 dispatch **之前**再做一次。
       *
       * 这一发是**真实完成的工作** —— 若在 `await probeProxy` 期间用户点了暂停,
       * 此刻 state 已是 `paused`,而 reducer 对 `probed` 的处置是「暂停时不推进」
       * （那条规则是对的:它挡的是前端在途轮询）。于是这一个计数会被永久丢掉 ——
       * 探测跑了、IP 也写回了,只有 `mainDone` 少了 1,最终停在 19/20。
       * 用户看到 95% 的「已结束」,会去找那个并不存在的失败节点,
       * 而每点一次暂停就再丢一个。
       *
       * 所以:暂停期间**不推进进度条**（用户看到的语义不变）,但恢复之后
       * 要把这一发补上。等到恢复再 dispatch 就同时满足这两条。
       * 第八轮审核实测查出（3 个节点暂停一次 → 终态 `mainDone:2/3`）。
       */
      await this.#waitIfPaused();
      this.#dispatch({ type: "probed" });
    }

    await this.#persist(outcomes);
    this.#dispatch({ type: "finished" });
  }

  /**
   * 把实测 IP 写回配置。
   *
   * **一次性写**，不是每探一个写一次：`saveConfig` 是整份原子写 + fsync，
   * 每个节点写一次意味着几十次 fsync，而中途任何一次失败都会留下
   * 「一半节点更新了」的状态。
   *
   * `applyProbeResult` 对失败**不清空**已有 IP —— 一次网络抖动不该让
   * 「这个代理的出口是什么」这条已知事实消失。那条规则在纯函数里。
   */
  async #persist(
    outcomes: Map<string, Awaited<ReturnType<EgressService["probeProxy"]>>["outcome"]>,
  ): Promise<void> {
    if (outcomes.size === 0) return;
    const config = this.#deps.configOf();

    let changed = false;
    const proxies = config.proxies.map((proxy) => {
      const outcome = outcomes.get(proxy.id);
      if (outcome === undefined) return proxy;
      const updated = applyProbeResult(proxy, outcome);
      if (updated.egressIp !== proxy.egressIp) changed = true;
      return updated;
    });

    if (!changed) return;
    try {
      await this.#deps.applyConfig({ ...config, proxies });
    } catch (err) {
      /*
       * 写盘失败**不影响探测结果的有效性** —— 它们已经被测到了，
       * 只是没能持久化。报出来，但不把整批标成失败:那会让用户以为
       * 探测本身出了问题。
       */
      this.#deps.log?.(`批量探测结果写入失败: ${safeErrorMessage(err)}`);
    }
  }
}
