import type { Config } from "../../shared/schema.ts";
import type { Response as UndiciResponse } from "undici";
import { upstreamUrl } from "../upstream/url.ts";
import { fetchUpstream, type UpstreamDeps } from "../upstream/fetch.ts";
import { buildUpstreamHeaders } from "../upstream/headers.ts";
import { classifyStatus } from "../failures.ts";
import { usableTargets } from "../routing/select.ts";
import { resolveProxy } from "../proxy/pool.ts";
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
 * 它完全没收录。信第三方聚合站与把某个模型 id 硬编码进代码是同一类错误。
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
 * 目录拉取的候选身份，顺序与 Worker 配置一致，是目录身份选择的唯一实现。
 *
 * 先过滤掉无法解析出口的 Worker：目录请求若选中停用代理/未启用 Clash 的
 * 首个 Worker，后面的健康 Worker 不该因为它而永远拿不到目录。候选仍收窄到
 * 首项所属的 keyed/keyless 槽，保持目录缓存的共享身份契约。
 * 目录与调度刻意不共享冷却状态；目录只使用可解析出口的启用 Worker。
 */
export function catalogIdentitiesOf(config: Config): CatalogIdentity[] {
  const identities: CatalogIdentity[] = [];
  for (const target of usableTargets(config)) {
    if (!resolveProxy(config, target.proxyId).ok) continue;
    const identity = { apiKey: target.apiKey, proxyId: target.proxyId };
    if (
      identities.some(
        (existing) => existing.apiKey === identity.apiKey && existing.proxyId === identity.proxyId,
      )
    ) {
      continue;
    }
    identities.push(identity);
  }

  if (identities.length === 0) return [{ apiKey: "", proxyId: null }];
  const slot = slotOf(identities[0]!);
  return identities.filter((identity) => slotOf(identity) === slot);
}

export function catalogIdentityOf(config: Config): CatalogIdentity {
  return catalogIdentitiesOf(config)[0]!;
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
 * 一次目录响应最多认这么多**条目**。
 *
 * 在架目录实测 41-80 条(按身份不同)。突然变成几千条意味着我们在跟别的东西
 * 说话(错配的 baseUrl、某个返回聚合列表的代理),此时**保留旧缓存**比采纳它安全。
 * 刻意不做截断:截断会静默丢掉免费模型,而丢掉哪些取决于上游的排序,
 * 症状是"某个模型时有时无"。
 *
 * ## 它守的是**条目数**,不是体积 —— 先前的注释把范围说宽了
 *
 * 这道闸门在 `parseCatalog` 里,也就是 `upstream.json()` **已经把整个体读进内存
 * 并解析完**之后。所以条目数少而体积巨大的响应不受任何约束 ——
 * 实测一个单条目、40 MiB 的目录响应被照常采纳。
 *
 * 先前注释说它防的是"劫持、错配的 baseUrl、返回聚合列表的代理",而**劫持**
 * 恰好能以小条目数、大体积的形态出现。所以它防的准确范围是
 * **条目数爆炸导致的判定集污染**,不是 DoS。
 *
 * **体积那一半由 `MAX_CATALOG_BYTES` 挡住（缺口 #7，第九轮补上）** ——
 * 有界读取放在 `JSON.parse` 之前，所以"单条目 40 MiB"那种形态不再能进内存。
 */
const MAX_CATALOG_ENTRIES = 4096;

/**
 * 目录响应的体积上限（缺口 #7）。
 *
 * 与条目数上限是**两层**，各自挡不同的东西：条目数挡"一万个模型"，
 * 体积挡"一个模型但它的 description 有 40 MiB"。实测过后者能通过
 * 条目数那一层。
 *
 * 8 MiB：当日真实目录约 42 条、几十 KB，三个数量级的余量。
 */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * 边读边计数地把响应读成文本。
 *
 * **不能只看 `content-length`**：那个头可以撒谎，chunked 编码也不给。
 * 与 `subscription/fetch.ts` 同一个做法（那里的理由写得更细），
 * 两处刻意不共用一个函数：这里拿的是 undici 的 Response，
 * 那里是 WHATWG fetch 的，形态不同而各自只有十几行。
 */
async function readBoundedText(response: UndiciResponse, limit: number): Promise<string> {
  /*
   * `body === null` 只出现在无体状态（204/205/304）上 —— 那时没有字节可数，
   * 返回空串即可：`JSON.parse("")` 会抛，调用点记一条「不是合法 JSON」并保留
   * 旧缓存，正是该有的结局。
   *
   * 这里**不重复一遍体积检查**：无体响应没有体积可超，而一条永远不可能为真的
   * 判断是测不出来的 —— 它只会让\"每条闸门都有能失败的测试\"这句话变得不成立。
   */
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`目录响应超过 ${limit} 字节`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

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
 * ## 为什么需要它:拉取失败**不填缓存**,所以"过期"这个条件不会自行消失
 *
 * 每个触发点都会看到"仍然过期"并再发一次。当前有两个触发点:
 *
 * - `/v1/models` 被访问时(`ensure`)—— OpenCode 会拉模型列表,有真实流量
 * - 转发路径判出 `retired` 时(`refreshIfStale`)—— 客户端反复请求一个
 *   已下架模型就会反复触发
 *
 * 两者都可能高频,而退避把"每次触发一发"压成"每 30 秒最多一发"。
 *
 * > **这段先前描述的是一个已经不存在的形态。** 原文写的是
 * > "`refreshIfStale` 在每个转发请求上调用",那是 Phase 6 第一版的错误耦合
 * > (一次客户端请求 → 两次上游请求,稳态永久 ×2),**已在同一轮改掉**:
 * > 现在转发路径只在 `retired` 那一支刷新。留着那句会让下一轮读到的人
 * > 以为"退避只是为了压住每请求刷新",于是若哪天删掉 `retired` 支的调用,
 * > 会误以为退避可以一起删 —— 而 `ensure` 那条路径仍然需要它。
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
  /**
   * 这份快照是否还在 TTL 内。
   *
   * `now` 可省 —— 省略时用**本类自己的**时钟。这一点要紧:先前
   * `models.ts` 传的是 `Date.now()`,而 `fetchedAt` 来自注入的 `#clock`,
   * 于是同一个响应体里两个字段来自**两个不同的时间源**。注入时钟的环境下
   * `fresh` 恒为 false(刚拉到的目录报告为"不新鲜"),生产环境下恒为 true ——
   * 两种情况下都无法用断言区分新鲜与过期,所以它是全仓唯一一个**无法被验证**
   * 的诊断字段。而 `architecture.md` 正把它当作目录状态的观察手段,
   * Phase 8 的 `doctor.mjs` 还要读它:一个会说假话的诊断字段比没有更糟。
   *
   * 修法不是给 `models.ts` 补一个 `clock` 依赖(那只是把同样的口子挪个位置,
   * 而 `status(now)` 是同一个形状,下一个调用点会照抄),而是让**时钟来源在这个
   * 类里唯一**。调用方仍可显式传 `now` 来断言边界。
   *
   * ## 这里刻意**没有**时钟回拨守卫,而 `refreshIfStale` 里有
   *
   * 两处的比较看起来该对称,其实不是 —— 第六轮审核穷举验证过:
   *
   * - 本方法:`catalogTtlMs` 的 schema 下界是 `60_000`(恒为正),所以
   *   `age < 0` **蕴含** `age < ttl`。加一条 `if (age < 0) return true`
   *   在任何合法配置下都改变不了返回值 —— 那是**数学死代码**
   *   (实测:所有负 age × 三个代表性 TTL,带与不带守卫零分歧)。
   * - `refreshIfStale`:那里比的是**退避窗口**,方向相反 —— 负 age 会让
   *   `age < FAILURE_BACKOFF_MS` 恒真,于是刷新被**永久冻住**。那条守卫是承重的。
   *
   * 先前两处都写着守卫、注释也一样,于是一条是死的、一条是活的而读者分不出来。
   * **保留一行永远不改变结果的代码比删掉它更危险**:下一个人会以为它在守什么,
   * 并据此推断本方法对时钟回拨有特殊处理。
   */
  isFresh(snapshot: CatalogSnapshot, config: Config, now: number = this.#clock()): boolean {
    /*
     * 时钟回拨(NTP 校正、休眠唤醒)让 age 为负时,结果自然落在"新鲜"一侧 ——
     * 依据是 `ModelRulesSchema` 给 `catalogTtlMs` 的 `.min(60_000)`,
     * 不是这里的某个判断。那个下界变成 0 或负数的话本方法才需要改。
     */
    return now - snapshot.fetchedAt < config.models.catalogTtlMs;
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

  /**
   * 诊断用。不含凭证 —— 只有槽位、条目数与年龄。
   *
   * `now` 可省,与 `isFresh` 同理:时钟来源在本类里唯一,调用方不各自决定。
   *
   * ## 生产调用点:`GET /api/overview`（Phase 9 批次 1 起）
   *
   * `routes/admin.ts` 读它填 `catalog.slots`,Models 页显示每个槽位的条目数与年龄
   * —— 正是下面那段曾经预期的用途。
   *
   * > 这里先前写着"⚠️ 本方法当前没有生产调用点,全仓只有 `catalog.test.ts` 在调它"。
   * > 第八轮审核查出那已经过期,且 `shared/contract.ts` 里同时写着"它此前没有
   * > 生产读者"—— 同一事实两处副本互相矛盾。这是纪律 #4 在**注释**这个载体上的
   * > 形态:"有没有读者"这件事的真相只能是调用点本身,手写标注必然漂。
   * > 登记在案的那个关卡（断言每个导出成员都有非测试引用）才是正解。
   *
   * `CatalogSnapshot.slot` 字段仍**只被本方法读**(`#slots` 这个 Map 的键来自
   * `slotOf()`,不是来自 `snapshot.slot`),那一条标注仍然成立。
   */
  status(now: number = this.#clock()): Array<{ slot: CatalogSlot; total: number; ageMs: number }> {
    return [...this.#slots.values()].map((s) => ({
      slot: s.slot,
      total: s.entries.length,
      // 时钟回拨时年龄夹到 0 —— 诊断输出里一个负年龄只会让人以为读错了字段。
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

    /*
     * 先限**体积**，再解析（缺口 #7）。
     *
     * `MAX_CATALOG_ENTRIES` 的闸门在 `parseCatalog` 里，也就是 `json()` 已经
     * 把整个体读进内存**之后** —— 实测一个单条目、40 MiB 的响应被照常采纳。
     * 条目数限制挡不住体积：一个条目的字段可以任意大。
     *
     * 当前风险不高（baseUrl 由 schema 限 http/https、频率受 TTL 与失败退避
     * 约束），但代价只是这几行，而"让 `baseUrl` 更开放"是个很自然的后续改动
     * —— 那时这一层不存在的话，一次配置失误就能把进程内存吃光。
     */
    let text: string;
    try {
      text = await readBoundedText(upstream, MAX_CATALOG_BYTES);
    } catch (err) {
      this.#log?.(`目录响应过大或读取失败(${slot}): ${safeErrorMessage(err)}`);
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
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
