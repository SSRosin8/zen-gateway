import type { Config } from "../../shared/schema.ts";
import type { Response as UndiciResponse } from "undici";
import { upstreamUrl } from "../upstream/url.ts";
import { fetchUpstream, type UpstreamDeps } from "../upstream/fetch.ts";
import { buildUpstreamHeaders } from "../upstream/headers.ts";
import { classifyStatus } from "../failures.ts";
import { usableTargets } from "../routing/select.ts";
import { resolveProxy } from "../proxy/pool.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { credentialFingerprint } from "../proxy/credentialFingerprint.ts";

/**
 * 上游在架目录：免费集判定里的「∩ 在架目录」，让下架项自动消失。
 * 反向不成立：`/zen/v1/models` 不给价格，新的无后缀免费模型只能人工补进 `extraFreeIds`。
 *
 * 只认 `/zen/v1/models`，不回落 models.dev 或 OpenCode 本地缓存（第三方聚合与在架目录
 * 差异很大）。模型页的协议面声明另取自 models.dev（`protocols.ts`），只作展示，不进判定。
 *
 * 缓存只分带 key／免 key 两个槽位：账号间整份目录确有差异，但差异全在付费模型上，
 * 免费子集一致，而网关只放行免费模型。这是上游性质，本地测试守不住，复核方法见
 * `docs/upstream-quirks.md` §7。
 *
 * 缓存保留「校验过的最后成功」且永不硬过期：目录消失等于网关拒绝一切。转发路径只读
 * `cached()`、绝不 await 拉取；刷新靠启动预热 + 访问时发现过期就后台刷新，不用定时器
 * （会吊住进程，而空闲网关的目录过期没有后果）。
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

/** 身份槽位，只有两个取值、不按 Worker 分（见文件头）。 */
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
 * 目录拉取的候选身份（唯一实现），顺序与 Worker 配置一致。先滤掉出口无法解析的 Worker，
 * 免得首个坏 Worker 让整份目录拉不到；再收窄到首项所属槽位。不与调度共享冷却状态。
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
 * 一次目录响应最多认的条目数（在架实测 41-80 条）。超过说明在跟别的东西说话，保留旧缓存；
 * 刻意不截断，否则丢哪些取决于上游排序。它只防条目数爆炸污染判定集，体积由
 * `MAX_CATALOG_BYTES` 挡。
 */
const MAX_CATALOG_ENTRIES = 4096;

/** 目录响应体积上限（真实目录几十 KB）；挡「单条目但字段巨大」这类条目数挡不住的形态。 */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * 边读边计数地把响应读成文本（`content-length` 可撒谎，chunked 也不给）。
 * 与 `subscription/fetch.ts` 同法但不共用：这里是 undici Response，那里是 WHATWG。
 * `protocols.ts` 拉 models.dev 也用它。
 */
export async function readBoundedText(response: UndiciResponse, limit: number): Promise<string> {
  // 无体状态（204/205/304）返回空串，调用点会因 JSON 解析失败而保留旧缓存。
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
        throw new Error(`响应超过 ${limit} 字节`);
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
  // 空目录不可采纳：采纳会清空免费集，比一次失败（还留着旧目录）严重得多。
  if (entries.length === 0) return null;

  return {
    slot,
    ids: new Set(entries.map((e) => e.id)),
    entries,
    fetchedAt: now,
  };
}

/**
 * 拉取失败后的重试间隔。失败不填缓存，「过期」不会自行消失，`ensure`（/v1/models）与
 * `refreshIfStale`（转发判出 retired）都会反复触发；退避把它压成每 30 秒最多一发。
 * 与可配的 `catalogTtlMs`（成功后的新鲜期）不同，这是纯自保参数，不可配。
 */
const FAILURE_BACKOFF_MS = 30_000;

/** 退避键不含明文 key:它与连接缓存同样用 `credentialFingerprint` 表示凭证身份。 */
function backoffKeyOf(identity: CatalogIdentity): string {
  return `${credentialFingerprint(identity.apiKey)}|${identity.proxyId ?? ""}`;
}

export type ModelCatalogOptions = {
  /** 注入以便测试推进时间。 */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
};

export class ModelCatalog {
  readonly #slots = new Map<CatalogSlot, CatalogSnapshot>();
  /** 同槽位的并发请求合流 —— 否则启动瞬间的一批请求各打一次上游。 */
  readonly #inFlight = new Map<CatalogSlot, Promise<CatalogSnapshot | null>>();
  /** 上次失败时刻，按身份（key 指纹 + 出口）而非槽位：否则一个坏出口会压住同槽位的健康 Worker。 */
  readonly #failedAt = new Map<string, number>();
  readonly #clock: () => number;
  readonly #log: ((message: string) => void) | undefined;

  constructor(opts?: ModelCatalogOptions) {
    this.#clock = opts?.clock ?? Date.now;
    this.#log = opts?.log;
  }

  /** 已缓存的那份，不发起请求。转发路径只用这个；null 时调用方退回不做交集。 */
  cached(slot: CatalogSlot): CatalogSnapshot | null {
    return this.#slots.get(slot) ?? null;
  }

  /**
   * 这份快照是否还在 TTL 内。`now` 省略时用本类时钟：时钟来源必须唯一，否则注入时钟下
   * `fetchedAt` 与 `now` 来自不同时间源，诊断字段 `fresh` 会说假话。
   * 刻意没有时钟回拨守卫：`catalogTtlMs` 下界为正，负 age 自然判为新鲜；
   * 承重的回拨守卫在 `#inBackoff`。
   */
  isFresh(snapshot: CatalogSnapshot, config: Config, now: number = this.#clock()): boolean {
    return now - snapshot.fetchedAt < config.models.catalogTtlMs;
  }

  /** 拿一份目录：新鲜直接给，否则去拉；拉失败返回旧的（可能已过期），从未成功才返回 null。 */
  async ensure(
    identity: CatalogIdentity,
    config: Config,
    upstreamOf: (config: Config) => UpstreamDeps,
  ): Promise<CatalogSnapshot | null> {
    const slot = slotOf(identity);
    const now = this.#clock();
    const have = this.#slots.get(slot);
    if (have !== undefined && this.isFresh(have, config, now)) return have;
    // 退避中不打上游，否则上游故障时每次模型列表请求放大成 N 次失败拉取。
    if (this.#inBackoff(identity, now)) return have ?? null;

    const fetched = await this.#fetchOnce(identity, config, upstreamOf);
    return fetched ?? this.#slots.get(slot) ?? null;
  }

  /**
   * 过期就在后台刷一次、立刻返回，不给转发加延迟；繁忙网关因此每 TTL 自然刷新。
   * 失败后必须退避，否则上游不稳时每次请求都变成两次上游请求。
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

    if (this.#inBackoff(identity, now)) return;

    // 必须吞掉异常：这是无人 await 的后台任务，抛出会变成 unhandledRejection。
    void this.#fetchOnce(identity, config, upstreamOf).catch(() => null);
  }

  /** 是否处在失败退避窗口内。`age < 0`（时钟回拨）视为退避已过，免得一次 NTP 校正冻住目录。 */
  #inBackoff(identity: CatalogIdentity, now: number): boolean {
    const failedAt = this.#failedAt.get(backoffKeyOf(identity));
    if (failedAt === undefined) return false;
    const age = now - failedAt;
    return age >= 0 && age < FAILURE_BACKOFF_MS;
  }

  /**
   * 诊断用（`GET /api/overview` 的 `catalog.slots`），不含凭证。`now` 省略时用本类时钟。
   * `CatalogSnapshot.slot` 字段只被本方法读。
   */
  status(now: number = this.#clock()): Array<{ slot: CatalogSlot; total: number; ageMs: number }> {
    return [...this.#slots.values()].map((s) => ({
      slot: s.slot,
      total: s.entries.length,
      // 时钟回拨时年龄夹到 0。
      ageMs: Math.max(0, now - s.fetchedAt),
    }));
  }

  /**
   * 同槽位合流的单次拉取，校验通过才替换缓存。失败记账集中在这里而非 `#doFetch` 的
   * 各个 `return null`，免得新增失败路径时漏记（纪律 #4）。
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
          this.#failedAt.set(backoffKeyOf(identity), this.#clock());
        } else {
          // 成功即清退避，否则下一次过期仍会被压住。
          this.#failedAt.delete(backoffKeyOf(identity));
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
      // 不读体也要释放，否则连接占着池直到 bodyTimeout。
      await upstream.body?.cancel().catch(() => {});
      this.#log?.(`目录拉取返回 ${upstream.status}(${slot})`);
      return null;
    }

    // 先限体积再解析：条目数上限在 `parseCatalog` 里，那时整个体已进内存。
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
      // 校验没过（空 data、缺 data、条目数离谱）即保留旧缓存。
      this.#log?.(`目录响应未通过校验(${slot}),保留上一份缓存`);
      return null;
    }

    this.#slots.set(slot, snapshot);
    return snapshot;
  }
}
