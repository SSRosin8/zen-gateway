import type { Config, RoutingStrategy, WorkerKind } from "../../shared/schema.ts";
import type { AttemptTarget } from "../upstream/retry.ts";
import { isUsable, isWorkerReady, WorkerPool, type WorkerRuntime } from "./workerPool.ts";
import { AffinityMap, digestOf, normalizeSessionKey } from "./affinity.ts";

/**
 * Worker 选择 —— 把冷却、粘滞、策略三件事合成一条**有序候选链**。
 *
 * ## 为什么返回一条链而不是单个 Worker
 *
 * 一个「每次只给一个 Worker」的选择函数下,重试链要换人就再调一次它 ——
 * 于是"这次请求会依次试哪些 Worker"这个问题在代码里没有答案,只能靠读
 * 那个 432 行 class 的隐式状态推。返回一条链之后,`retry.ts` 只需按序走,
 * 而"为什么是这个顺序"完全由本文件回答。
 *
 * ## 排序规则(优先级从高到低)
 *
 *   1. **粘滞命中且就绪**的 Worker —— 严格粘滞,不被策略抢占
 *   2. 其余**就绪**的 Worker,按策略排序
 *   3. 若一个都不就绪:只给**最早恢复**的那一个
 *
 * 第 3 条不是轮转槽位,也不是"把所有冷却中的都排上"。两者都错:
 *
 * - 轮转槽位会在全员冷却时把请求散到恢复最晚的那个,重试互相错过。
 * - 把冷却中的 Worker 排进候选尾巴,等于让"有健康 Worker 时也可能打到
 *   冷却中的",而冷却存在的理由正是别再打它 —— 尤其 429:上游刚说了
 *   `Retry-After: 900`,我们在 2 秒后又发一次只会换来更长的封禁。
 *
 * 所以规则是:**有就绪的就只用就绪的**;一个都没有时给一个最接近恢复的,
 * 让客户端拿到一次真实的上游错误(而不是网关自造的 503)。
 */

/** 策略 → 优先的 Worker 类别;`null` 表示不排序(按配置顺序)。 */
function preferredKind(strategy: RoutingStrategy): WorkerKind | null {
  switch (strategy) {
    /*
     * 三个取值都**真的生效**,产出三种不同的候选顺序。
     *
     * 我先前在这里(以及 `docs/architecture.md` 的缺口清单、plan)断言
     * 「匿名 Worker 的定义就是没有 key,所以这个分支的输入集恒为空」。
     * 第五轮审核证伪了它,两个独立 agent 从不同入口撞上同一条 —— 因为
     * `WorkerSchema` 的 refine 是**单向**的:
     *
     * ```ts
     * .refine((w) => w.kind === "anonymous" || w.apiKey.trim() !== "")
     * ```
     *
     * 它只要求「authenticated 必须有 key」,对 anonymous **不作任何约束**。
     * 所以 `{ kind: "anonymous", apiKey: "..." }` 既合法又可用(`isUsable`
     * 只看 key 不看 kind),排序真的按 kind 生效,而且 `anonymous_first`
     * 正是 schema 的默认值 —— 默认配置下就生效。
     *
     * 我那个错误推理正是纪律 #6 的形态:把一次测量(免 key 通道已关闭)
     * 推广成一个结构性结论(这个分支不可能有输入)。空的是**实践**输入集
     * (关闭免 key 通道后,没人有理由配一个 kind 为 anonymous 却带 key 的
     * Worker),不是**合法**输入集。差别很实在:前者用户现在就能造出来看到
     * 效果,后者意味着"改这个字段不会有可见变化"—— 而那句话是假的。
     */
    case "anonymous_first":
      return "anonymous";
    case "authenticated_first":
      return "authenticated";
    case "mixed":
      return null;
    default: {
      const exhaustive: never = strategy;
      throw new Error(`未处理的调度策略:${String(exhaustive)}`);
    }
  }
}

function toTarget(worker: WorkerRuntime): AttemptTarget {
  return { workerId: worker.id, apiKey: worker.apiKey, proxyId: worker.proxyId };
}

/** 本次选择用到的亲和上下文。全部可缺 —— 缺了就退化成纯策略排序。 */
export type AffinityContext = {
  readonly map: AffinityMap;
  /** 已归一化并哈希的会话键;拿不到会话标识时为 null。 */
  readonly sessionHash: string | null;
  /** 请求体里加密推理块的 sha256 指纹。 */
  readonly blobHashes: readonly string[];
};

export type SelectInput = {
  readonly pool: WorkerPool;
  readonly config: Config;
  readonly now: number;
  readonly affinity?: AffinityContext;
};

/** 选择结果。`reason` 只用于诊断,不参与任何判断。 */
export type Selection = {
  readonly targets: readonly AttemptTarget[];
  /** 链首 Worker 是怎么定下来的。 */
  readonly reason: "sticky" | "blob_hint" | "strategy" | "all_cooling" | "empty";
  /** 命中粘滞时是哪个 Worker,便于日志与诊断头。 */
  readonly stickyWorkerId: string | null;
};

/**
 * 排出候选链。
 *
 * **有副作用**:命中亲和提示或新选出 Worker 时会写入会话绑定。
 * 绑定发生在**选择时**而不是成功之后,有两个理由:
 *
 * 1. 同一会话的并发请求要落到同一个 Worker。若等成功才绑,两个同时进来的
 *    turn 会各自挑一个,而它们回放的是同一批推理块 —— 其中一个必定被上游拒。
 * 2. 绑定本身是自纠正的:被绑的 Worker 一旦进入冷却,下一轮
 *    `lookupSession` 就查不到它,自动解绑重挑。
 *
 * ## TTL 是滑动的,不是从首次绑定起算
 *
 * 每次选择都重写绑定时间,所以 `affinityTtlMs` 度量的是**闲置**时长:
 * 一条持续活跃的会话永不解绑,闲置超过 TTL 才失效。
 *
 * 固定 TTL(从首次绑定起算)会在一条**正在进行**的长对话中途强制换 Worker,
 * 而那恰好是粘滞要避免的事 —— 换了 Worker,客户端回放的加密推理块就会被
 * 上游拒掉,表现为对话到某个时刻突然开始报错。TTL 的目的是清理**已结束**的
 * 会话(腾出容量、不让几个月前的绑定钉住未来的会话),活跃会话不在其列。
 */
export function select(input: SelectInput): Selection {
  const { pool, config, now } = input;
  const all = pool.all();
  if (all.length === 0) {
    return { targets: [], reason: "empty", stickyWorkerId: null };
  }

  const ttlMs = config.routing.affinityTtlMs;
  const exists = (id: string): boolean => pool.has(id);
  /*
   * 就绪判定走 `isWorkerReady` 这个唯一定义,不在这里手写 `<= now`。
   *
   * 先前这里是第四份手写的同一个比较(另三份在 `workerPool.ts`),而更糟的是
   * **同一个函数里两份判定并存**:这个过滤器用手写的,下面的粘滞校验用
   * `pool.isReady`。按纪律 #4,并行的判断必然分叉,方向是漏。
   */
  const ready = all.filter((w) => isWorkerReady(w.cooldownUntil, now));

  /* ---- 1. 粘滞 ---- */
  let sticky: WorkerRuntime | null = null;
  let reason: Selection["reason"] = "strategy";
  /**
   * 会话绑定的 Worker,**可能正在冷却**。
   *
   * 记住它而不是立刻解绑:第 3 步(全员冷却)需要知道"这条会话本来属于谁",
   * 否则会把绑定迁走。见那里的说明。
   */
  let boundId: string | null = null;

  const ctx = input.affinity;
  if (ctx !== undefined && ctx.sessionHash !== null) {
    boundId = ctx.map.lookupSession(ctx.sessionHash, now, ttlMs, exists);
    /*
     * 绑定存在且就绪 → 严格粘滞。
     *
     * 绑定存在但在冷却 → 放弃粘滞,重新挑(不在这里解绑)。等它恢复是错的:
     * 冷却可能长达 15 分钟,而客户端只会看到网关卡住。代价是这一轮的推理
     * 连续性丢失(上游会拒掉回放的推理块),但那是**上游的**错误,
     * 客户端能看到并开一个新 turn —— 好于我们自己把请求挂住。
     *
     * 先前这里有一句显式 `unbindSession()`。去掉它有两个理由:
     * 一是第 4 步的 `bind(head)` 本来就会覆盖那条绑定(变异测试证实那行是
     * 死代码);二是第 3 步**需要**它还在。
     */
    if (boundId !== null && pool.isReady(boundId, now)) {
      sticky = pool.get(boundId);
      reason = "sticky";
    }
  }

  /* ---- 2. 推理指纹提示(仅在没有会话绑定时) ---- */
  if (sticky === null && ctx !== undefined && ctx.blobHashes.length > 0) {
    const hinted = ctx.map.findBlobWorker(ctx.blobHashes, now, ttlMs, exists);
    if (hinted !== null && pool.isReady(hinted, now)) {
      sticky = pool.get(hinted);
      reason = "blob_hint";
    }
  }

  /* ---- 3. 全员冷却:只给最早恢复的那一个,且**不动会话绑定** ---- */
  if (ready.length === 0) {
    const earliest = all.reduce((best, w) => (w.cooldownUntil < best.cooldownUntil ? w : best));

    /*
     * 这里**刻意不 bind**。
     *
     * 第五轮审核查出的缺陷:先前这条分支无条件 `bind(earliest)`,于是一次
     * 短暂的全员冷却窗口就能把会话绑定**永久**迁走。实测:
     *
     * ```
     * 轮1 链: [w1, w2]                      绑定 w1(w1 签发了推理块)
     * 轮2 链: [w2]  reason = all_cooling    → 改绑 w2
     * 轮3 链: [w2, w1] reason = sticky      ← 指纹真相是 w1
     * ```
     *
     * 指纹映射保留了正确答案 w1,但第 2 步的指纹提示只在 `sticky === null`
     * 时才查 —— 会话绑定已命中,那份正确信息永远读不到。症状与我用集成测试
     * 查出的那个缺陷完全一致:对话隔一会儿报一次错,只在限流之后出现。
     *
     * 为什么不 bind 是安全的:这一轮打的是一个正在冷却的 Worker,很可能失败;
     * 若它**成功**了,`relay.ts` 的 `rebind()` 会把绑定落到实际承接者身上 ——
     * 那才是正确的时机(那时才知道推理块是谁签发的)。
     *
     * 为什么仍选"最早恢复"而不是选绑定的那个:全员冷却时无论选谁都在违反
     * 冷却,而打一个刚被 429 的 Worker 可能换来更长的封禁。最早恢复的那个
     * 是"违反得最轻"的选择。推理连续性靠**保住绑定**来救,不靠这一轮的选择。
     */
    return {
      targets: [toTarget(earliest)],
      reason: "all_cooling",
      // 绑定仍在(如果本来有),但这一轮不是粘滞命中。
      stickyWorkerId: null,
    };
  }

  /* ---- 4. 就绪的按策略排序,粘滞的提到最前 ---- */
  const preferred = preferredKind(config.routing.strategy);
  const ordered =
    preferred === null
      ? [...ready]
      : /*
         * `sort` 自 ES2019 起**保证稳定**,所以同类别内部保持配置顺序 ——
         * 用户手工排的优先级不会被策略打乱。
         */
        [...ready].sort((a, b) => rank(a, preferred) - rank(b, preferred));

  const targets =
    sticky === null
      ? ordered.map(toTarget)
      : [toTarget(sticky), ...ordered.filter((w) => w.id !== sticky.id).map(toTarget)];

  const head = targets[0];
  if (head !== undefined) bind(ctx, head.workerId, now, ttlMs);

  return { targets, reason, stickyWorkerId: sticky?.id ?? null };
}

function rank(worker: WorkerRuntime, preferred: WorkerKind): number {
  return worker.kind === preferred ? 0 : 1;
}

function bind(
  ctx: AffinityContext | undefined,
  workerId: string,
  now: number,
  ttlMs: number,
): void {
  if (ctx === undefined || ctx.sessionHash === null) return;
  ctx.map.bindSession(ctx.sessionHash, workerId, now, ttlMs);
}

/**
 * 从客户端头与请求体解析会话哈希。
 *
 * `x-opencode-session` 是 chat 面**唯一**的会话依据(该面请求体里没有会话
 * 标识),而 `headers.ts` 保证它一定存在 —— 客户端没发时网关合成一个。
 * 但合成的那个每请求都不同,所以对亲和没有帮助:那种情况下粘滞自然失效,
 * 这是正确的(我们确实不知道这是不是同一条会话)。
 *
 * `sessionKeyFrom` 给 Responses 面用 —— 它的 `previous_response_id` 是体内的
 * 会话指针。体内标识**优先**于头:它是协议自己的语义,比客户端的自定义头更权威。
 */
export function sessionHashFrom(input: {
  readonly bodyKey: string | undefined;
  readonly headerValue: string | undefined;
}): string | null {
  const raw = normalizeSessionKey(input.bodyKey) ?? normalizeSessionKey(input.headerValue);
  return raw === null ? null : digestOf(raw);
}

/* ------------------------------------------------------------------ *
 * 兼容既有调用点
 * ------------------------------------------------------------------ */

/**
 * 不含调度状态的候选链 —— 供 `/v1/models` 使用。
 *
 * 目录查询是幂等只读的,且**不走重试链**:它只需要"任意一个能用的 key"。
 * 让它也建一个 WorkerPool 是多余的,而让它共用转发面的池更糟 ——
 * 一次目录查询失败会把 Worker 打进冷却,于是**一个只读查询影响了转发的
 * 候选顺序**。两者刻意不共享状态。
 */
export function usableTargets(config: Config): AttemptTarget[] {
  return config.workers.filter(isUsable).map((w) => ({
    workerId: w.id,
    apiKey: w.apiKey,
    proxyId: w.proxyId,
  }));
}

/** 供诊断:说明为何没有候选。 */
export function describeNoWorker(config: Config): string {
  if (config.workers.length === 0) {
    return "尚未配置任何 Worker";
  }
  const enabled = config.workers.filter((w) => w.enabled);
  if (enabled.length === 0) {
    return "所有 Worker 都已停用";
  }
  return "所有已启用的 Worker 都缺少上游 API key";
}

export { isUsable };
