import { createHash } from "node:crypto";
import { ProtocolIdSchema, type Config, type ProtocolId, type Proxy } from "../../shared/schema.ts";
import type {
  ModelView,
  Overview,
  ProxyView,
  SecretPresence,
  SubscriptionView,
  WorkerView,
} from "../../shared/contract.ts";
import { isUsable } from "../../core/routing/workerPool.ts";
import { describeResolveFailure, resolveProxy } from "../../core/proxy/pool.ts";
import { judgeFree } from "../../core/models/free.ts";
import type { ProtocolSnapshot } from "../../core/models/protocols.ts";
import { redactUrl } from "../../shared/redact.ts";
import type { CatalogSnapshot } from "../../core/models/catalog.ts";

/**
 * 配置 → 管理面视图的投影。本文件是唯一允许读凭证字段的地方，且只输出 `SecretPresence`：
 * 窄化散落在各 handler 里，新增端点时漏一个字段不会有任何症状。
 */

/**
 * 凭证的展示指纹：sha256 前 8 位。刻意不复用 `credentialFingerprint`：那是缓存重建的安全边界，
 * 这里是展示用途，两者约束不同。用指纹而非长度：换成同长度的正确密码时界面才看得出变化。
 */
export function displayFingerprint(secret: string): SecretPresence {
  const trimmed = secret.trim();
  if (trimmed === "") return { present: false, fingerprint: null };
  return {
    present: true,
    fingerprint: createHash("sha256").update(secret).digest("hex").slice(0, 8),
  };
}

/** 调度器暴露给投影层的运行期状态。只要这一小片，不要整个 Scheduler。 */
export type RuntimeWorkerState = {
  readonly id: string;
  readonly ready: boolean;
  readonly cooldownRemainingMs: number;
  readonly consecutiveFails: number;
  readonly lastFailure: string | null;
};

/**
 * 合成配置里的 Worker 与调度器运行期状态：「为什么没在用这个账号」必须两者一起才能回答。
 * `inPool` 与 `enabled` 分开显示（匿名 Worker 可免 key）；runtime 里查不到的 Worker `ready` 为 false。
 */
export function workerViews(
  config: Config,
  runtime: readonly RuntimeWorkerState[],
): WorkerView[] {
  const byId = new Map(runtime.map((r) => [r.id, r] as const));
  const proxyById = new Map(config.proxies.map((p) => [p.id, p] as const));

  return config.workers.map((worker): WorkerView => {
    const state = byId.get(worker.id);
    const inPool = isUsable(worker);

    return {
      id: worker.id,
      name: worker.name,
      kind: worker.kind,
      enabled: worker.enabled,
      proxyId: worker.proxyId,
      apiKey: displayFingerprint(worker.apiKey),
      inPool,
      // 不在池里就一定不就绪：`#retired` 会为停用的 Worker 保留状态，照 `state.ready` 会显示「已停用 · 就绪」。
      ready: inPool && state !== undefined ? state.ready : false,
      cooldownRemainingMs: state?.cooldownRemainingMs ?? 0,
      consecutiveFails: state?.consecutiveFails ?? 0,
      lastFailure: state?.lastFailure ?? null,
      /*
       * 直连 Worker 的出口 IP 来自 `gateway.directEgressIp`（实测落盘），未探测时为 null（隔离报告算未知）。
       * 不能编值：直连与某代理 NAT 到同一 IP 正是「看似隔离其实没隔离」。
       */
      egressIp:
        worker.proxyId === null
          ? config.gateway.directEgressIp
          : (proxyById.get(worker.proxyId)?.egressIp ?? null),
    };
  });
}

/**
 * 供 `buildIsolationReport` 使用的条目。只取候选池里的 Worker：停用的不发流量，
 * 算进来会让 `isolated` 永远为 false。
 */
export function isolationEntries(
  views: readonly WorkerView[],
): Array<{ workerId: string; proxyId: string | null; egressIp: string | null }> {
  return views
    .filter((v) => v.inPool)
    .map((v) => ({ workerId: v.id, proxyId: v.proxyId, egressIp: v.egressIp }));
}

/** 代理概览。 */
export function proxySummary(proxies: readonly Proxy[]): {
  total: number;
  enabled: number;
  withEgressIp: number;
} {
  return {
    total: proxies.length,
    enabled: proxies.filter((p) => p.enabled).length,
    withEgressIp: proxies.filter((p) => p.egressIp !== null).length,
  };
}

/**
 * Clash 配置的投影，`apiSecret` 换成指纹。`localProxyPort` 原样给出：不是凭证，
 * 且与内核实际 `mixed-port` 不一致时桥接会静默失败，界面必须能看到。
 */
export function clashView(config: Config): Overview["clash"] {
  return {
    enabled: config.clash.enabled,
    selectionMode: config.clash.selectionMode,
    activeBridgeId: config.clash.activeBridgeId,
    bridges: config.clash.bridges.map((b) => ({
      id: b.id,
      name: b.name,
      enabled: b.enabled,
      priority: b.priority,
      apiBase: b.apiBase,
      apiSecret: displayFingerprint(b.apiSecret),
      localProxyHost: b.localProxyHost,
      localProxyPort: b.localProxyPort,
      selectorGroup: b.selectorGroup,
    })),
  };
}

/** Worker 池计数，从同一份 `views` 推导而不另问调度器，与 `workers[].ready` 结构上不会矛盾。 */
export function poolCounts(views: readonly WorkerView[]): { ready: number; total: number } {
  const inPool = views.filter((v) => v.inPool);
  return { ready: inPool.filter((v) => v.ready).length, total: inPool.length };
}

/**
 * 用于自检的凭证字符串清单，测试断言这些值不出现在响应里。放在生产代码里从 `Config` 推导（纪律 #4）。
 * 订阅 URL 只取像凭证的片段（query 值与路径末段）：整条 URL 的前 8 位恒为 `https://`，
 * 既查不到 token 又会与 `gateway.baseUrl` 误报。
 */
export function allSecretValues(config: Config): string[] {
  const out: string[] = [config.gateway.relayToken, config.gateway.lanPasswordHash ?? ""];
  for (const w of config.workers) out.push(w.apiKey);
  for (const b of config.clash.bridges) out.push(b.apiSecret);
  for (const p of config.proxies) {
    if (p.password !== undefined) out.push(p.password);
  }
  for (const s of config.subscriptions) out.push(...subscriptionSecrets(s.url));
  // 太短的片段会造成误报（`/v1`、`a=1`），它们也不可能是真凭证。
  return out.filter((v) => v.trim().length >= 8);
}

/** 从订阅 URL 里取出"像凭证"的片段 —— 见 `allSecretValues` 的说明。 */
function subscriptionSecrets(raw: string): string[] {
  const out: string[] = [];
  try {
    const url = new URL(raw);
    for (const [, value] of url.searchParams) out.push(value);
    const lastSegment = url.pathname.split("/").filter((s) => s !== "").at(-1);
    if (lastSegment !== undefined) out.push(lastSegment);
  } catch {
    // 不是合法 URL 时退回整条 —— schema 本该挡住，但这里不能因此漏检。
    out.push(raw);
  }
  return out;
}

/** 转出以便 handler 不必认识 workerPool。 */
/**
 * 代理列表的投影，由服务端算好：`password` → `SecretPresence`；`usedBy` 与 `patch.ts` 的引用完整性同源；
 * `resolvable` 复用 `resolveProxy`（纪律 #4）。
 */
export function proxyViews(config: Config): ProxyView[] {
  const usedByProxy = new Map<string, string[]>();
  for (const w of config.workers) {
    if (w.proxyId === null) continue;
    const list = usedByProxy.get(w.proxyId) ?? [];
    list.push(w.id);
    usedByProxy.set(w.proxyId, list);
  }

  return config.proxies.map((p): ProxyView => {
    const resolved = resolveProxy(config, p.id);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      host: p.host,
      port: p.port,
      enabled: p.enabled,
      source: p.source,
      bridgeId: p.bridgeId ?? null,
      clashNodeName: p.clashNodeName ?? null,
      direct: p.direct,
      bridgeable: p.bridgeable,
      egressIp: p.egressIp,
      password: displayFingerprint(p.password ?? ""),
      usedBy: usedByProxy.get(p.id) ?? [],
      resolvable: resolved.ok,
      // 措辞复用 `describeResolveFailure` —— 与转发失败时用户看到的是同一句话。
      unresolvableReason: resolved.ok ? null : describeResolveFailure(resolved.failure),
    };
  });
}

/** 模型页协议列的两个来源，见 `ModelViewSchema.protocol`。 */
export type ModelProtocolSources = {
  readonly declared: ProtocolSnapshot | null;
  /** model → 得到过 2xx 的协议面（`StatsStore.modelProtocols`）。 */
  readonly measured: ReadonlyMap<string, readonly string[]>;
};

/**
 * 模型列表的投影。付费的也列出来：Models 页要回答「为什么这个模型不能用」。
 * `reason` 直接取自 `judgeFree`，不另造措辞（纪律 #4）。
 */
export function modelViews(
  config: Config,
  snapshot: CatalogSnapshot | null,
  protocols: ModelProtocolSources,
): ModelView[] {
  if (snapshot === null) return [];

  const view = { ids: snapshot.ids };
  /*
   * 额外列出配置里记着但已从目录消失的免费模型，否则 `retired` 在生产响应中永远不出现。
   * 只来自当前配置，不从历史数据猜。
   */
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry] as const));
  for (const id of config.models.extraFreeIds) entries.set(id, entries.get(id) ?? { id });

  return [...entries.values()].map((entry): ModelView => {
    const verdict = judgeFree(entry.id, config.models, view);
    return {
      id: entry.id,
      free: verdict.free,
      reason: verdict.reason,
      protocol: {
        declared: protocols.declared?.byModel.get(entry.id) ?? null,
        // 库里的 protocol 列是字符串；只认网关现有的面，旧数据里的未知值不外泄成契约外取值。
        measured: (protocols.measured.get(entry.id) ?? []).filter(
          (p): p is ProtocolId => ProtocolIdSchema.safeParse(p).success,
        ),
      },
      listed: snapshot.ids.has(entry.id),
    };
  });
}

/**
 * 订阅列表的投影。URL 过 `redactUrl` 后才出去（token 本身是付费凭证）。
 * `proxyCount` 由服务端算：前端拿到的代理列表是分页/筛选后的。
 */
export function subscriptionViews(config: Config): SubscriptionView[] {
  const counts = new Map<string, number>();
  for (const p of config.proxies) {
    if (p.subscriptionId === undefined) continue;
    counts.set(p.subscriptionId, (counts.get(p.subscriptionId) ?? 0) + 1);
  }

  return config.subscriptions.map((s) => ({
    id: s.id,
    name: s.name,
    urlRedacted: redactUrl(s.url),
    enabled: s.enabled,
    lastFetchedAt: s.lastFetchedAt,
    lastErrorKind: s.lastErrorKind,
    lastImportCount: s.lastImportCount,
    lastFormat: s.lastFormat,
    proxyCount: counts.get(s.id) ?? 0,
  }));
}
