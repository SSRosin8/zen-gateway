import type { Config } from "../../shared/schema.ts";
import { reduce, type BatchProgress } from "../../shared/batchProbe.ts";
import { INITIAL } from "../../shared/batchProbe.ts";
import type { BatchProbeStore } from "../../store/db/batchProbeStore.ts";
import type { EgressService } from "../../core/proxy/egress.ts";
import { applyProbeResults } from "../../core/proxy/egress.ts";
import { describeResolveFailure, resolveProxy } from "../../core/proxy/pool.ts";
import { DIRECT_EGRESS_ID } from "../../shared/schema.ts";
import { usedProxyIds } from "../../core/routing/workerPool.ts";
import { applyConfigPatch } from "./patch.ts";
import { bulkAnonymousWorkers, duplicateEgressIds } from "../../shared/workerIds.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import type { BatchProgressView } from "../../shared/contract.ts";
import { lockedBridgeFor, type BridgeHealth } from "../../core/proxy/clash/select.ts";

/**
 * 批量探测执行器：把 `shared/batchProbe.ts` 的纯 reducer 接到真实探测上，进度由
 * `store/db/batchProbeStore.ts` 持久化。两段：筛选（`resolveProxy`，纯本地）→ 主探测（真发请求）。
 * 执行在后台、不 await：几十秒的 HTTP 请求会被中间层掐断，进度靠轮询拿。
 */

/**
 * 批测中一个节点的状态，取自线上契约（`BatchProgressSchema.nodes`），不另写一份。
 * `skipped` = 筛选段被挡下（配置问题）或整批提前结束时没轮到。
 */
export type BatchNodeStatus = DistributiveOmit<BatchProgressView["nodes"][number], "proxyId">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type BatchRunnerDeps = {
  readonly configOf: () => Config;
  readonly applyConfig: (next: Config, expected?: Config) => Promise<void>;
  readonly egress: EgressService;
  readonly store: BatchProbeStore;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  /**
   * 批测前探一遍 Clash 内核以锁定一个。不传则跳过锁定，这是降级：
   * 中途换内核会让隔离报告混入两个内核的出口。生产必须传。
   */
  readonly probeBridges?: () => Promise<readonly BridgeHealth[]>;
};

export class BatchProbeRunner {
  #deps: BatchRunnerDeps;
  #progress: BatchProgress;
  #startedAt: number | null;
  /** 正在跑的那一轮，用作进程内互斥：状态落盘是异步的，并发 start 都会先读到 `idle`。 */
  #running: Promise<void> | null = null;
  /** 暂停的等待点，`resume` 时 resolve；用 Promise 而非轮询，避免恢复延迟。 */
  #resumeSignal: (() => void) | null = null;
  /**
   * 本批逐个节点的状态，供代理池表格按行显示「探测中 / 成功 / 失败」。只在进程内存里：
   * 它是进行中的视图，最终结果已写回配置（egressIp），重启后不需要恢复。
   */
  #nodes = new Map<string, BatchNodeStatus>();

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

  /** 本批逐个节点的状态（id → 状态），按探测顺序。 */
  nodes(): ReadonlyArray<{ proxyId: string } & BatchNodeStatus> {
    return [...this.#nodes].map(([proxyId, s]) => ({ proxyId, ...s }));
  }

  /**
   * 以批测互斥锁跑一个同样会切 selector 的操作（`POST /api/probe`）。已有一批或另一个独占操作在跑时
   * 返回 `null`，调用方回 409；运行期间 `start()` 也返回 false。两者并发会互相切 selector，
   * 回显报告就成了噪声。
   */
  async runExclusive<T>(task: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.#running !== null) return null;
    const run = task();
    // 锁只关心何时结束，不关心成败；失败由下面的 await 抛给调用方。
    this.#running = run.then(
      () => {},
      () => {},
    );
    try {
      return { value: await run };
    } finally {
      this.#running = null;
    }
  }

  /** 本批开始的时刻；从未跑过时为 null。供 `elapsedMs`，刷新后前端无从得知。 */
  startedAt(): number | null {
    return this.#startedAt;
  }

  #dispatch(event: Parameters<typeof reduce>[1]): void {
    const next = reduce(this.#progress, event);
    if (next === this.#progress) return; // 不合法的转移，不写盘
    this.#progress = next;
    this.#deps.store.save(next, this.#now(), this.#startedAt ?? this.#now());
  }

  /**
   * 开始一批。返回 false 表示已有一批在跑或无可探出口，调用方回 409 而不排队：
   * 两批并发会互相切 selector。
   *
   * 范围是代理池里全部已启用节点（批测回答「池里哪些节点能用」），外加在用的本机直连。
   * `createWorkers` 为 true 时，结束后为探测成功、未被引用、且回显 IP 与已有出口不重复的
   * 节点各建一个匿名 Worker（显式选项，默认不建）。
   */
  start(opts: { createWorkers?: boolean } = {}): boolean {
    if (this.#running !== null) return false;

    const config = this.#deps.configOf();
    const proxyIds = batchTargets(config);
    if (proxyIds.length === 0) return false;

    this.#startedAt = this.#now();
    this.#progress = INITIAL;
    this.#nodes = new Map(proxyIds.map((id) => [id ?? DIRECT_EGRESS_ID, { state: "queued" } as BatchNodeStatus]));
    this.#dispatch({ type: "start", screenTotal: proxyIds.length });

    this.#running = this.#run(proxyIds, opts.createWorkers === true)
      .catch((err) => {
        this.#deps.log?.(`批量探测异常: ${safeErrorMessage(err)}`);
        this.#settleNodes("批测异常中断");
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
   * 请求取消。进 `cancelling` 而非立刻 `done`：在途探测仍在切 selector，
   * 立刻放开按钮会让第二批并发。`done` 由 `#run` 发现取消标记后给出。
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

  async #run(proxyIds: Array<string | null>, createWorkers: boolean): Promise<void> {
    // `let`：第 0 段可能写回 `activeBridgeId`，之后的筛选与探测必须用写回后的那份。
    let config = this.#deps.configOf();

    /* ---- 第 0 段：锁定单内核 ---- */
    if (this.#deps.probeBridges !== undefined && config.clash.enabled) {
      /*
       * 批测期间锁定一个内核（不变量 #5 的延伸）：中途换内核会让隔离报告的 IP 分组变成噪声。
       * 探不到可用内核时不中止，直连代理仍可探。
       * 择优结果必须写回 `activeBridgeId`：`pickBridge`（`pool.ts`）只按配置取端口，
       * 只打日志的话后续探测仍会打到死内核。
       */
      try {
        const health = await this.#deps.probeBridges();
        const locked = lockedBridgeFor(config.clash, health);
        this.#deps.log?.(locked.reason);

        if (locked.bridgeId !== null && locked.bridgeId !== config.clash.activeBridgeId) {
          // 只在真的换了时写盘；`lockedBridgeFor` 不透传 `changed`，用 id 比较等价。
          const expected = this.#deps.configOf();
          const next = {
            ...expected,
            clash: { ...expected.clash, activeBridgeId: locked.bridgeId },
          };
          await this.#deps.applyConfig(next, expected);
          // 重取而不是用 `next`：`applyConfig` 之后进程内的真相是它换进去的那个引用。
          config = this.#deps.configOf();
        }
      } catch (err) {
        // 探活本身失败不该让批测停下 —— 它只是少了一个保证。
        this.#deps.log?.(`内核探活失败，批测继续（未锁定）: ${safeErrorMessage(err)}`);
      }
    }

    /* ---- 第一段：筛选（纯本地，很快） ---- */
    const passed: Array<string | null> = [];
    for (const proxyId of proxyIds) {
      if (this.#progress.cancelRequested) {
        this.#settleNodes("已取消");
        this.#dispatch({ type: "finished", failureKind: "cancelled" });
        return;
      }
      // 筛选复用 `resolveProxy`：纯本地判断，坏配置的代理不占真实探测，且与主探测不会分叉。
      const resolved = resolveProxy(config, proxyId);
      if (resolved.ok) passed.push(proxyId);
      else this.#nodes.set(proxyId ?? DIRECT_EGRESS_ID, { state: "skipped", reason: describeResolveFailure(resolved.failure) });
      this.#dispatch({ type: "screened" });
    }

    this.#dispatch({ type: "screenDone", mainTotal: passed.length });

    /* ---- 第二段：主探测（真发请求） ---- */
    const outcomes = new Map<string, Awaited<ReturnType<EgressService["probeProxy"]>>["outcome"]>();

    for (const proxyId of passed) {
      await this.#waitIfPaused();

      if (this.#progress.cancelRequested) {
        await this.#finishCancelled(outcomes);
        return;
      }

      // 逐个串行：进度要逐个报，桥接探测本就被 selector 锁串行化。
      const nodeId = proxyId ?? DIRECT_EGRESS_ID;
      this.#nodes.set(nodeId, { state: "probing" });
      const result = await this.#deps.egress.probeProxy(config, proxyId);
      outcomes.set(result.proxyId, result.outcome);
      const o = result.outcome;
      this.#nodes.set(
        nodeId,
        o.ok
          ? { state: "ok", egressIp: o.egressIp, latencyMs: o.latencyMs }
          : { state: "failed", reason: `${o.failureKind}:${o.reason}` },
      );

      /*
       * dispatch 前再做一次暂停检查：reducer 暂停时不推进 `probed`，
       * 在 await 期间被暂停的这一发会被永久丢掉（终态停在 19/20）。等恢复后再补上。
       */
      await this.#waitIfPaused();
      this.#dispatch({ type: "probed" });
    }

    await this.#persist(outcomes);
    /*
     * 循环只在每轮开头看取消：最后一个节点探测中或写回期间点的暂停/取消到这里才处理。
     * 暂停先等；取消了就不再新建 Worker —— 用户要停的正是这一步。
     */
    await this.#waitIfPaused();
    if (this.#progress.cancelRequested) {
      await this.#finishCancelled(new Map());
      return;
    }
    if (createWorkers) {
      for (const id of await this.#createFor(outcomes)) this.#dispatch({ type: "workerAdded", workerId: id });
    }
    this.#dispatch({ type: "finished" });
  }

  /**
   * 取消生效：已探到的照样写回（那些是真实测量），没轮到的节点标为已取消。
   * 先写回再给 `done`：`done` 会放开「开始」，新一批的写回不能与这次交错。
   */
  async #finishCancelled(outcomes: Map<string, Awaited<ReturnType<EgressService["probeProxy"]>>["outcome"]>): Promise<void> {
    this.#settleNodes("已取消");
    await this.#persist(outcomes);
    this.#dispatch({ type: "finished", failureKind: "cancelled" });
  }

  /** 整批提前结束时，把还在排队或探测中的节点落到终态，否则表格会一直显示「排队中」。 */
  #settleNodes(reason: string): void {
    for (const [id, n] of this.#nodes) {
      if (n.state === "queued" || n.state === "probing") this.#nodes.set(id, { state: "skipped", reason });
    }
  }

  /**
   * 为可用且出口不重复的节点建匿名 Worker，一次写盘。命名与后台的批量导入同一份
   * （`shared/workerIds.ts`），id 接着 `anon-N`。只建直连或桥接节点，不建本机直连。
   */
  async #createFor(outcomes: Map<string, { ok: boolean; egressIp?: string }>): Promise<string[]> {
    const config = this.#deps.configOf();
    const used = new Set(config.workers.map((w) => w.proxyId).filter((p): p is string => p !== null));
    const takenIps = new Set(config.proxies.filter((p) => used.has(p.id) && p.egressIp !== null).map((p) => p.egressIp!));
    if (config.gateway.directEgressIp !== null && config.workers.some((w) => w.proxyId === null)) {
      takenIps.add(config.gateway.directEgressIp);
    }
    // 候选 = 本批探测成功、未被引用的节点；出口去重与后台批量导入同一条规则。
    const candidates = config.proxies.flatMap((proxy) => {
      const o = outcomes.get(proxy.id);
      return o?.ok === true && o.egressIp !== undefined && !used.has(proxy.id) ? [{ proxy, id: proxy.id, egressIp: o.egressIp }] : [];
    });
    const duplicate = duplicateEgressIds(takenIps, candidates);
    const picked = candidates.filter((c) => !duplicate.has(c.id)).map(({ proxy }) => ({ id: proxy.id, name: proxy.clashNodeName ?? proxy.name }));
    if (picked.length === 0) return [];
    const create = bulkAnonymousWorkers(config.workers.map((w) => w.id), picked);
    // 与后台保存走同一个合并（`applyConfigPatch`）：id 冲突、上限与引用检查只有一处。
    const merged = applyConfigPatch(config, { workers: { create } });
    if (!merged.ok) {
      this.#deps.log?.(`批测后新建 Worker 失败: ${merged.failure.message}`);
      return [];
    }
    try {
      await this.#deps.applyConfig(merged.config, config);
    } catch (err) {
      this.#deps.log?.(`批测后新建 Worker 写入失败: ${safeErrorMessage(err)}`);
      return [];
    }
    return create.map((w) => w.id);
  }

  /**
   * 把实测 IP 一次性写回配置，避免每个节点一次 fsync 与「一半更新」的状态。
   * 失败不清空已有 IP，规则在 `applyProbeResults` 里。
   */
  async #persist(
    outcomes: Map<string, Awaited<ReturnType<EgressService["probeProxy"]>>["outcome"]>,
  ): Promise<void> {
    if (outcomes.size === 0) return;
    const config = this.#deps.configOf();

    // 与 `POST /api/probe` 同走 `applyProbeResults`，同时处理本机直连那条。
    const merged = applyProbeResults(config, outcomes);
    if (!merged.changed) return;
    try {
      await this.#deps.applyConfig(merged.config, config);
    } catch (err) {
      // 写盘失败不把整批标成失败：测量本身有效，只是没能持久化。
      this.#deps.log?.(`批量探测结果写入失败: ${safeErrorMessage(err)}`);
    }
  }
}

/** 批测范围：全部已启用的代理节点 + 在用的本机直连（`null`）。 */
export function batchTargets(config: Config): Array<string | null> {
  const ids: Array<string | null> = config.proxies.filter((p) => p.enabled).map((p) => p.id);
  if (usedProxyIds(config).includes(null)) ids.push(null);
  return ids;
}
