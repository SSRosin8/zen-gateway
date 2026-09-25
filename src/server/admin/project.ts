import { createHash } from "node:crypto";
import type { Config, Proxy, Worker } from "../../shared/schema.ts";
import type {
  ModelView,
  ProxyView,
  SecretPresence,
  SubscriptionView,
  WorkerView,
} from "../../shared/contract.ts";
import { isUsable, isWorkerReady } from "../../core/routing/workerPool.ts";
import { describeResolveFailure, resolveProxy } from "../../core/proxy/pool.ts";
import { judgeFree, surfacesFor } from "../../core/models/free.ts";
import { redactUrl } from "../../shared/redact.ts";
import type { CatalogSnapshot } from "../../core/models/catalog.ts";

/**
 * 配置 → 管理面视图的投影。
 *
 * ## 这一层存在的唯一理由：凭证绝不出进程
 *
 * `config.json` 整个文件都是凭证（Zen API key、Relay Token、代理口令、
 * Clash secret）。管理面要回答的是「这个 Worker 配没配 key」而**不是** key
 * 本身，所以投影必须**窄于**存储 —— 而窄化只在这一个文件里做，不散落在
 * 各个 handler 里。散落的后果是可预见的：新增一个端点时漏掉一个字段，
 * 而那个漏洞没有任何症状（响应照常返回，只是多带了一个 key）。
 *
 * 因此本文件是**唯一**允许读凭证字段的地方，且它只输出 `SecretPresence`。
 * 有一条测试遍历响应的全部字符串值，断言真实 key 不出现在任何一处。
 */

/**
 * 凭证的展示指纹：sha256 前 8 位。
 *
 * ## 为什么不复用 `credentialFingerprint.ts`
 *
 * 那个函数是**安全边界**（决定 dispatcher / Controller 是否重建），它的取值
 * 范围由「碰撞会导致复用旧凭证」这条后果决定。这里是**展示用途**，约束不同：
 * 必须短到能在界面上显示，而碰撞的后果只是两个不同 key 看起来一样。
 *
 * 两个用途共用一个函数会让其中一方的约束变化悄悄影响另一方 —— 比如为了
 * 界面好看把长度截短，就会削弱缓存键。所以刻意分开，并在两处互相注明。
 *
 * **用指纹而不是长度**：等长的两个 key 长度相同，于是「我改了没生效」
 * 在界面上不可见 —— 而那恰好是修密码最常见的形态（把打错的换成同长度的对的）。
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
 * 把配置里的 Worker 与调度器的运行期状态合成一个视图。
 *
 * ## 合并是这个端点存在的全部理由
 *
 * `config.json` 知道「配了什么」，`Scheduler` 知道「现在能不能用」，
 * 而用户问的那个问题（「它为什么没在用我这个账号」）**必须两者一起**
 * 才能回答。先前 `npm run status` 只报进程信息、Phase 8 的 `doctor` 只能报
 * 配置形态 —— 就是因为进程外没有任何地方同时持有这两半。
 *
 * ## `inPool` 与 `enabled` 必须分开显示
 *
 * `isUsable()` 除了 `enabled` 还要求 apiKey 非空（免 key 通道已被上游关闭）。
 * 合成一个字段的话，「启用了但没 key」会显示成启用，而用户会发现它从不被
 * 选中却找不到原因。
 *
 * `runtime` 里查不到的 Worker（不在候选池里）—— `ready` 为 false 而不是
 * 「未知」：它确实不会被选中，这是个确定的事实，不是缺失信息。
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
      /*
       * 不在池里就一定不就绪 —— 不看 `state`。
       *
       * 这不是防御性冗余:`#retired` 表会为停用过的 Worker 保留状态,
       * 于是一个 `enabled: false` 的 Worker 仍可能有一条 runtime 记录
       * (冷却已过期 → ready 为真)。照 `state.ready` 显示会得到
       * 「已停用 · 就绪」,而它根本不在候选链里。
       */
      ready: inPool && state !== undefined ? state.ready : false,
      cooldownRemainingMs: state?.cooldownRemainingMs ?? 0,
      consecutiveFails: state?.consecutiveFails ?? 0,
      lastFailure: state?.lastFailure ?? null,
      /*
       * 出口 IP 来自绑定的代理；`proxyId` 为 null（本机直连）时来自
       * `gateway.directEgressIp`（缺口 #28）。
       *
       * 先前直连一律给 null，理由是"没有实测过本机出口，而编一个值会让隔离
       * 报告把所有直连 Worker 归成一组『已知相同』" —— **那个理由在没有
       * 实测值时是对的**，而现在探测会真的把它测出来并落盘。
       *
       * 这条很要紧：直连出口与某个代理 NAT 到同一个公网 IP 恰好是
       * 「看起来隔离其实没隔离」的形态，而它此前结构上不可能被发现。
       * 仍未探测过时是 null（→ 隔离报告里算「未知」，不算已隔离）。
       */
      egressIp:
        worker.proxyId === null
          ? config.gateway.directEgressIp
          : (proxyById.get(worker.proxyId)?.egressIp ?? null),
    };
  });
}

/**
 * 供 `buildIsolationReport` 使用的条目。
 *
 * **只取在候选池里的 Worker**：一个停用的 Worker 不发流量，把它算进隔离
 * 报告会让「未知出口」凭空多出几个，于是 `isolated` 永远为 false ——
 * 用户永远看到「出口未隔离」而实际在用的那几个是隔离的。
 */
export function isolationEntries(
  config: Config,
  views: readonly WorkerView[],
): Array<{ workerId: string; proxyId: string | null; egressIp: string | null }> {
  return views
    .filter((v) => v.inPool)
    .map((v) => ({ workerId: v.id, proxyId: v.proxyId, egressIp: v.egressIp }));
}

/** 代理概览。完整列表在 ProxyPool 页（下一批）。 */
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
 * Clash 配置的投影。`apiSecret` 换成指纹。
 *
 * `localProxyPort` 原样给出 —— 它不是凭证，而且它是 Phase 8 实测出的那个
 * 高风险字段（与内核实际 `mixed-port` 不一致时桥接静默连到没人监听的端口），
 * 所以界面上必须能看到它。
 */
export function clashView(config: Config): {
  enabled: boolean;
  activeBridgeId: string | null;
  bridges: Array<{
    id: string;
    name: string;
    enabled: boolean;
    apiBase: string;
    apiSecret: SecretPresence;
    localProxyPort: number;
    selectorGroup: string;
  }>;
} {
  return {
    enabled: config.clash.enabled,
    activeBridgeId: config.clash.activeBridgeId,
    bridges: config.clash.bridges.map((b) => ({
      id: b.id,
      name: b.name,
      enabled: b.enabled,
      apiBase: b.apiBase,
      apiSecret: displayFingerprint(b.apiSecret),
      localProxyPort: b.localProxyPort,
      selectorGroup: b.selectorGroup,
    })),
  };
}

/**
 * Worker 池计数 —— 从投影推导，**不另外问一次调度器**。
 *
 * `Scheduler.counts()` 也能给这个数，但那会让同一个响应里的
 * `pool.ready` 与 `workers[].ready` 来自两次独立的查询，中间状态可能变过；
 * 而用户会把它们当成一句话读（「3 个 Worker，2 个就绪」后面跟着一张
 * 三行的表）。从同一份 `views` 推导，两者结构上不可能矛盾。
 *
 * 这也顺带回答了 Phase 8 登记的那个问题（`counts()` 无生产读者）：
 * 它仍然没有读者，而那是对的 —— 这里需要的是**与列表同源**的计数。
 */
export function poolCounts(views: readonly WorkerView[]): { ready: number; total: number } {
  const inPool = views.filter((v) => v.inPool);
  return { ready: inPool.filter((v) => v.ready).length, total: inPool.length };
}

/**
 * 用于自检的凭证字符串清单 —— 测试用它断言「这些值不出现在响应里」。
 *
 * 放在生产代码里而不是测试里，理由是纪律 #4：测试若自己手写一份
 * 「哪些字段算凭证」的名单，schema 加一个凭证字段时那份名单不会更新，
 * 而**脱节方向必然是漏**。这里从 `Config` 的实际结构推导。
 *
 * ## 订阅 URL 只取**token 部分**，不取整条
 *
 * 第八轮审核查出：先前 push 的是整条 `https://host/path?token=SECRET`，
 * 而测试断言的是 `not.toContain(secret.slice(0, 8))` —— 对每个订阅来说
 * 那 8 个字符都是 `"https://"`。于是
 *
 * - 真正是凭证的那段 token **完全没被检查**；
 * - 而任何含订阅的配置都会让断言**误报**，因为 `gateway.baseUrl`
 *   正当地以 `https://` 开头。
 *
 * 所以这里把 URL 拆开，只交出"看起来像凭证"的那几段：query 的各个值、
 * 以及路径的最后一段（`/sub/abc123def` 这种形态）。粒度必须与缺陷的
 * 粒度一致 —— 查整条 URL 挡不住"只泄漏 token"。
 */
export function allSecretValues(config: Config): string[] {
  const out: string[] = [config.gateway.relayToken];
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

/** 判定一个 Worker 现在是否就绪 —— 转出以便 handler 不必认识 workerPool。 */
export { isUsable, isWorkerReady };
export type { Worker };

/* ------------------------------------------------------------------ *
 * 其余页面的投影（Phase 9 批次 2）
 * ------------------------------------------------------------------ */

/**
 * 代理列表的投影。
 *
 * 三样东西由服务端算好，而不是让前端拼:
 *
 * 1. `password` → `SecretPresence`（代理口令是凭证）
 * 2. `usedBy` —— 哪些 Worker 引用它。前端要按它显示「删掉会影响谁」，
 *    而那个判断若在前端做，就与 `patch.ts` 的引用完整性校验成了两份实现，
 *    分叉后界面会允许一个服务端必拒的操作。
 * 3. `resolvable` —— 能否解析出一条出口路径。复用 `resolveProxy` 而不是
 *    另写一份「Clash 开了吗 / 协议能直连吗」的判断（纪律 #4）。
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

/**
 * 模型列表的投影。
 *
 * ## 为什么要把**付费的也列出来**
 *
 * Models 页要回答「为什么这个模型不能用」，而那必须看到被拒的那些。
 * 只列免费集的话，用户在 OpenCode 里看到一个模型名却在这里找不到它，
 * 于是不知道是「网关不认识它」还是「网关拒绝它」。
 *
 * `reason` 直接来自 `judgeFree` 的联合类型 —— 不在这里另造一套措辞
 * （纪律 #4：那会让界面说的理由与转发时的理由分叉）。
 */
export function modelViews(config: Config, snapshot: CatalogSnapshot | null): ModelView[] {
  if (snapshot === null) return [];

  const view = { ids: snapshot.ids };
  return snapshot.entries.map((entry): ModelView => {
    const verdict = judgeFree(entry.id, config.models, view);
    return {
      id: entry.id,
      free: verdict.free,
      reason: verdict.reason,
      /*
       * `surfacesFor` 终于有了生产调用点 —— 但**只作展示**，不参与放行判定。
       *
       * 缺口 #10 说清了为什么不能顺手把它接成闸门:默认值是
       * `["chat","responses"]`，按它放行会让默认配置下**所有**模型的
       * `/v1/messages` 请求被拒 —— 而那个面 Phase 6 刚验证可用。
       * 上游并不按模型区分面，所以当闸门缺乏依据。这里是它该有的用法。
       */
      surfaces: [...surfacesFor(entry.id, config.models)],
      listed: snapshot.ids.has(entry.id),
    };
  });
}

/**
 * 订阅列表的投影（Phase 10）。
 *
 * **URL 过 `redactUrl` 后才出去** —— 订阅 URL 的 token 通常带在 query 或
 * path 里，它本身就是付费凭证。这与 apiKey 只给指纹是同一条规则：
 * 界面要回答"这是哪个订阅"，不该让人从界面把 token 抄走。
 *
 * `proxyCount` 由服务端算 —— 前端拿到的 `proxies` 是分页/筛选后的，
 * 让它自己数会得到一个随筛选变化的数字。
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
