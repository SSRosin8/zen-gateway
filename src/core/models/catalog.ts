import type { Config } from "../../shared/schema.ts";
import { upstreamUrl } from "../upstream/url.ts";
import { fetchUpstream, type UpstreamDeps } from "../upstream/fetch.ts";
import { buildUpstreamHeaders } from "../upstream/headers.ts";
import { classifyStatus } from "../failures.ts";
import { usableTargets } from "../routing/select.ts";
import { safeErrorMessage } from "../../shared/redact.ts";

/**
 * 上游在架目录 —— 免费集那个交集里的「∩ 在架目录」。
 *
 * ## 这个交集要解决的具体问题
 *
 * 免费判定先前是纯函数：`(后缀命中 ∪ extraFreeIds)`。它**放得偏宽** ——
 * 一个已下架的 `glm-5-free` 后缀命中，于是被放行，然后由上游返回
 * 400 `Model is unavailable.`。交集让下架项自动消失，而这是唯一的自动机制。
 *
 * **不对称要说清**：交集能自动剔除下架的，但**新出现的无后缀免费模型无法
 * 自动发现** —— `/zen/v1/models` 给在架性却**不给价格**，价格只在文档站的
 * HTML 定价表里（且客户端渲染）。所以新的零费率无后缀模型只能人工补进
 * `extraFreeIds`。别让用户以为刷新一下就能拿到全部免费模型。
 *
 * ## 目录只认 `/zen/v1/models`
 *
 * 不回落到 models.dev，也不读 OpenCode 的本地缓存（`~/.cache/opencode/
 * models.json` 就是 models.dev 的快照）。实测同日 models.dev 报 105 个模型／
 * 32 个零费率，与在架目录比对后有 **23 个零费率项已下架**，另有 3 个在架模型
 * 它完全没收录。信第三方聚合站与旧项目硬编码 `union-alpha` 是同一类错误。
 *
 * ## 两个身份槽位,而依据是**免费子集**一致,不是整份目录一致
 *
 * 缓存按「带 key／免 key」两个槽位存,而不是 per-Worker 的 N 个。这个选择的
 * 依据经过三次修正,值得完整写下来 —— 因为前两次的理由都被后一次的测量推翻:
 *
 * 1. **09-22(一个账号)**:测到带 key 与免 key 目录不同,据此推断"per-Worker",
 *    并写进 `architecture.md` 说"缓存键必须含 Worker 身份"。
 * 2. **09-23(两个账号)**:两个账号看到的**差异项完全相同**,于是推翻上一条,
 *    改写成"按带 key／免 key 两种**身份**区分,不按账号个体"。
 * 3. **09-23 晚(三个账号,本阶段实测)**:**上一条也是错的。** 三个付费账号里
 *    两个看到 41 个模型,一个看到 79 个(三轮稳定,且全部经同一个本机出口发出,
 *    排除了地域差异)。所以**账号个体差异真实存在**。
 *
 * 那为什么还用两个槽位?因为**差异全在付费模型上,免费子集三个账号完全一致**
 * (各 9 个,逐 id 相同)。而本网关只放行免费模型 —— 交集判定要的恰好是那个
 * 一致的子集。
 *
 * 这条才是本模块真正依赖的不变式,而它比"目录按身份区分"**弱得多** ——
 * 但它是被测量支持的那一条。
 *
 * **它没有本地测试守着,也守不住**:那是上游的性质,不是本仓代码的性质,
 * 单测无论怎么写都只是在断言我自己造的 fixture。记录在
 * `docs/upstream-quirks.md` §7,复核办法是拿多个账号各拉一次目录比对免费子集。
 * (我第一版注释在这里声称"catalog.test.ts 钉住了它" —— 那是假的,
 * 正是纪律 #7 那类"把代码里有的能力写成用户能看到它"的变体。)
 *
 * 本地测试能守的是**这条假设不成立时的处置**,而那已经配了用例:
 *
 * - 缓存里**有**而某 Worker 没有 → 上游 400 `Model is unavailable` →
 *   归 `bad_request` → 不重试、不归咎 Worker、原样透传。可见且自限。
 * - 缓存里**没有**而某 Worker 有 → 网关误拒一个可用模型。这一侧更糟,
 *   所以 `judgeFree` 判出 `retired` 时会触发一次目录刷新(见 `relay.ts`)。
 *
 * 真出现那天的修法是规划里记的"并集":`/v1/models` 取所有启用 Worker 的并集,
 * 而路由时按该 Worker 自己的目录校验。代价是 N 次上游请求,眼下不值得。
 *
 * ## 缓存必须「校验过的最后成功」
 *
 * 先前 `/v1/models` 每次请求都打一次上游，于是**上游抖动时目录跟着消失** ——
 * 而目录消失等于免费集为空，等于网关拒绝一切。所以：
 *
 * 1. 只有**校验通过**的响应才替换缓存。一个 200 带 `{"data":[]}` 会把免费集
 *    清空，那比请求失败更糟（失败我们还留着旧的）。
 * 2. 失败时**继续用旧的**，而且旧的**永不硬过期**。模型目录以天为单位变化，
 *    一份三天前的目录远好于"网关不可用"。
 * 3. 转发路径**绝不 await** 目录请求，只读已缓存的那份（见 `cached()`）。
 *    让每个转发请求先等一次目录查询，是把一个只读优化变成转发链路上的
 *    第二个网络依赖。
 *
 * ## 为什么没有定时器
 *
 * 规划写的是"启动预热 + 定时刷新"。这里用**启动预热 + 访问时发现过期就后台
 * 刷新**，不用 `setInterval`：定时器会吊住进程（本项目的 shutdown 已经要
 * 显式关 dispatcher 池才能退出），而一个完全空闲的网关目录过期没有任何后果 ——
 * 没人在问。繁忙的网关则每 TTL 自然刷新一次，可观察行为与定时刷新相同。
 */

/** 上游目录条目。只认 id 是字符串的，其余字段原样保留。 */
export type ModelEntry = { readonly id: string } & Record<string, unknown>;

export function isModelEntry(value: unknown): value is ModelEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/**
 * 身份槽位。
 *
 * 只有两个取值，见文件头 —— 不按 Worker 分。
 */
export type CatalogSlot = "keyed" | "keyless";

/** 拉目录用的身份。`apiKey` 为空串表示免 key。 */
export type CatalogIdentity = {
  readonly apiKey: string;
  readonly proxyId: string | null;
};

export function slotOf(identity: CatalogIdentity): CatalogSlot {
  return identity.apiKey === "" ? "keyless" : "keyed";
}

/**
 * 拉目录该用哪个身份 —— **唯一定义处**。
 *
 * 三个调用点需要它:启动预热、`/v1/models`、转发路径上的"已下架"复核。
 * 先前我在三处各写了一遍(`identityFor`、`catalogIdentity`、以及 index.ts 里
 * 又一份),那是纪律 #4 的原形态:三份并行的同一份真相,而脱节方向
 * **必然是各自算出不同的槽位** —— 于是一处填进 `keyed` 槽的目录,
 * 另一处去 `keyless` 槽里找,交集静默失效而没有任何报错。
 *
 * 取第一个可用 Worker 的 key;没有可用 Worker 时是空串(免 key)——
 * 实测 Zen 的目录端点免鉴权可读,所以首次配置前也能看到目录,
 * 对「方便简单」有实际帮助。
 *
 * 用 `usableTargets` 而不是当次请求的候选链:目录与调度**刻意不共享状态**
 * (一个只读查询不该改变转发的候选顺序),而且一个正在冷却的 Worker 的 key
 * 照样能拉目录 —— 目录端点与额度闸门无关。
 */
export function catalogIdentityOf(config: Config): CatalogIdentity {
  const first = usableTargets(config)[0];
  return { apiKey: first?.apiKey ?? "", proxyId: first?.proxyId ?? null };
}

export type CatalogSnapshot = {
  readonly slot: CatalogSlot;
  /** 在架 id 集合。判定用这个，不要遍历 entries。 */
  readonly ids: ReadonlySet<string>;
  /** 上游条目原样保留 —— 客户端可能依赖 `created`/`owned_by`。 */
  readonly entries: readonly ModelEntry[];
  readonly fetchedAt: number;
};

/**
 * 一次目录响应最多认这么多条目。
 *
 * 在架目录实测 76-79 条。突然变成几千条意味着我们在跟别的东西说话
 * （劫持、错配的 baseUrl、某个返回聚合列表的代理），此时**保留旧缓存**比
 * 采纳它安全。刻意不做截断：截断会静默丢掉免费模型，而丢掉哪些取决于上游的
 * 排序，症状是"某个模型时有时无"。
 */
const MAX_CATALOG_ENTRIES = 4096;

/** 目录解析结果。`null` 表示这份响应不可采纳（见 MAX_CATALOG_ENTRIES）。 */
export function parseCatalog(payload: unknown, slot: CatalogSlot, now: number): CatalogSnapshot | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  if (data.length > MAX_CATALOG_ENTRIES) return null;

  const entries = data.filter(isModelEntry);
  /*
   * 空目录不可采纳。
   *
   * 这一条是整个缓存的要点：一个 200 带空 data 会把免费集清空，于是网关
   * 拒绝一切合法请求 —— 比一次请求失败严重得多，因为失败时我们还留着旧目录。
   * `data` 是数组但一条都没有的情况，当作"这次没拿到目录"处理。
   */
  if (entries.length === 0) return null;

  return {
    slot,
    ids: new Set(entries.map((e) => e.id)),
    entries,
    fetchedAt: now,
  };
}

/**
 * 拉取失败后至少隔这么久才再试。
 *
 * ## 没有它的时候是一个真实的放大器
 *
 * `refreshIfStale` 在每个转发请求上调用,而拉取失败**不会**填上缓存 ——
 * 于是下一个请求发现仍然过期,又发一次。稳态下一次客户端请求对应
 * **两次**上游请求,而且这个放大恰好发生在上游已经不稳的时候。
 *
 * 30 秒是这样定的:目录以天为单位变化,所以"晚 30 秒恢复"没有代价;
 * 而它足够短,不会让一次网络抖动把目录冻住很久。
 *
 * 注意这是**失败**间隔,与 `catalogTtlMs`(成功后的新鲜期)是两件事:
 * 后者可配,因为它影响"新加的模型多久生效";前者不可配,因为它纯粹是
 * 一个自保参数,用户没有理由调它。
 */
const FAILURE_BACKOFF_MS = 30_000;

export type ModelCatalogOptions = {
  /** 注入以便测试推进时间。 */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
};

export class ModelCatalog {
  readonly #slots = new Map<CatalogSlot, CatalogSnapshot>();
  /** 同槽位的并发请求合流 —— 否则启动瞬间的一批请求各打一次上游。 */
  readonly #inFlight = new Map<CatalogSlot, Promise<CatalogSnapshot | null>>();
  /** 上次失败的时刻,按槽位。见 FAILURE_BACKOFF_MS。 */
  readonly #failedAt = new Map<CatalogSlot, number>();
  readonly #clock: () => number;
  readonly #log: ((message: string) => void) | undefined;

  constructor(opts?: ModelCatalogOptions) {
    this.#clock = opts?.clock ?? Date.now;
    this.#log = opts?.log;
  }

  /**
   * 已缓存的那份，不发起任何请求。
   *
   * **转发路径只用这个。** 没有缓存时返回 null，调用方据此退回"不做交集"
   * （行为等同 Phase 5），而不是拒绝请求 —— 见 `judgeFree` 的说明。
   */
  cached(slot: CatalogSlot): CatalogSnapshot | null {
    return this.#slots.get(slot) ?? null;
  }

  /** 这份快照是否还在 TTL 内。 */
  isFresh(snapshot: CatalogSnapshot, config: Config, now: number): boolean {
    const age = now - snapshot.fetchedAt;
    // 时钟回拨（NTP 校正、休眠唤醒）会让 age 为负 —— 当作新鲜，不要当成过期。
    if (age < 0) return true;
    return age < config.models.catalogTtlMs;
  }

  /**
   * 拿一份目录：新鲜就直接给，过期或没有就去拉。
   *
   * 拉失败时**返回旧的**（可能已过期）而不是 null —— 那正是"最后成功缓存"
   * 的用处。只有从来没成功过才返回 null。
   */
  async ensure(
    identity: CatalogIdentity,
    config: Config,
    upstreamOf: (config: Config) => UpstreamDeps,
  ): Promise<CatalogSnapshot | null> {
    const slot = slotOf(identity);
    const now = this.#clock();
    const have = this.#slots.get(slot);
    if (have !== undefined && this.isFresh(have, config, now)) return have;

    const fetched = await this.#fetchOnce(identity, config, upstreamOf);
    // 拉失败 → 用旧的（哪怕过期）。这是"上游抖动时目录不跟着消失"的落点。
    return fetched ?? this.#slots.get(slot) ?? null;
  }

  /**
   * 过期就在后台刷一次，立刻返回。
   *
   * 转发路径用它：不 await，所以不给请求加延迟；而一个繁忙的网关会因此
   * 每 TTL 自然刷新一次目录 —— 这就是"定时刷新"的可观察行为，不需要定时器。
   *
   * **失败后必须退避**，否则这里是个放大器：失败不填缓存 → 下个请求仍发现
   * 过期 → 再发一次，稳态下一次客户端请求变成两次上游请求，而放大恰好发生在
   * 上游已经不稳的时候。见 `FAILURE_BACKOFF_MS`。
   */
  refreshIfStale(
    identity: CatalogIdentity,
    config: Config,
    upstreamOf: (config: Config) => UpstreamDeps,
  ): void {
    const slot = slotOf(identity);
    const now = this.#clock();
    const have = this.#slots.get(slot);
    if (have !== undefined && this.isFresh(have, config, now)) return;

    /*
     * 刚失败过就先不试。
     *
     * `age < 0` 是时钟回拨 —— 当作"退避已过"处理(宁可多试一次,
     * 也不要因为一次 NTP 校正把目录冻住)。
     */
    const failedAt = this.#failedAt.get(slot);
    if (failedAt !== undefined) {
      const age = now - failedAt;
      if (age >= 0 && age < FAILURE_BACKOFF_MS) return;
    }

    // 必须吞掉异常：这是无人 await 的后台任务，抛出会变成 unhandledRejection。
    void this.#fetchOnce(identity, config, upstreamOf).catch(() => null);
  }

  /** 诊断用。不含凭证 —— 只有槽位、条目数与年龄。 */
  status(now: number): Array<{ slot: CatalogSlot; total: number; ageMs: number }> {
    return [...this.#slots.values()].map((s) => ({
      slot: s.slot,
      total: s.entries.length,
      ageMs: Math.max(0, now - s.fetchedAt),
    }));
  }

  /**
   * 同槽位合流的单次拉取。成功且校验通过才替换缓存。
   *
   * **失败记账在这里,而不是在 `#doFetch` 的四个 `return null` 上。**
   * 那四条路径(网络异常、非 2xx、体不是 JSON、校验没过)是同一个结论的四种
   * 原因,在每条上各写一次 `#failedAt.set` 就是四份并行的同一份真相 ——
   * 而按纪律 #4,那种分叉迟早会漏掉新加的第五条。这里只问一件事:
   * 这次拉取**有没有产出可用快照**。
   */
  #fetchOnce(
    identity: CatalogIdentity,
    config: Config,
    upstreamOf: (config: Config) => UpstreamDeps,
  ): Promise<CatalogSnapshot | null> {
    const slot = slotOf(identity);
    const running = this.#inFlight.get(slot);
    if (running !== undefined) return running;

    const task = this.#doFetch(identity, slot, config, upstreamOf)
      .then((snapshot) => {
        if (snapshot === null) {
          this.#failedAt.set(slot, this.#clock());
        } else {
          // 成功了就清掉退避,否则一次成功之后的下一次过期还会被压住。
          this.#failedAt.delete(slot);
        }
        return snapshot;
      })
      .finally(() => {
        this.#inFlight.delete(slot);
      });
    this.#inFlight.set(slot, task);
    return task;
  }

  async #doFetch(
    identity: CatalogIdentity,
    slot: CatalogSlot,
    config: Config,
    upstreamOf: (config: Config) => UpstreamDeps,
  ): Promise<CatalogSnapshot | null> {
    let upstream;
    try {
      upstream = await fetchUpstream(
        {
          url: upstreamUrl(config.gateway.baseUrl, "/models"),
          method: "GET",
          headers: buildUpstreamHeaders({
            clientHeaders: {},
            apiKey: identity.apiKey,
            streaming: false,
          }),
          body: null,
          proxyId: identity.proxyId,
        },
        upstreamOf(config),
      );
    } catch (err) {
      this.#log?.(`目录拉取失败(${slot}): ${safeErrorMessage(err)}`);
      return null;
    }

    if (classifyStatus({ status: upstream.status, headers: upstream.headers }) !== null) {
      // 不读体也要释放它 —— 悬挂的连接会占着池直到 bodyTimeout。
      await upstream.body?.cancel().catch(() => {});
      this.#log?.(`目录拉取返回 ${upstream.status}(${slot})`);
      return null;
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch (err) {
      this.#log?.(`目录响应不是合法 JSON(${slot}): ${safeErrorMessage(err)}`);
      return null;
    }

    const snapshot = parseCatalog(payload, slot, this.#clock());
    if (snapshot === null) {
      /*
       * 校验没过 —— **保留旧缓存**。
       *
       * 这条路径覆盖空 data、缺 data、以及条目数离谱三种情况。共同点是
       * "采纳它会让免费集变错"，而旧的那份至少曾经是对的。
       */
      this.#log?.(`目录响应未通过校验(${slot}),保留上一份缓存`);
      return null;
    }

    this.#slots.set(slot, snapshot);
    return snapshot;
  }
}
