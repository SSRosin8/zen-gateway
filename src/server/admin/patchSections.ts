import type { Config } from "../../shared/schema.ts";
import { ClashBridgeSchema, SubscriptionSchema } from "../../shared/schema.ts";
import type { ConfigPatch, SecretPatch } from "../../shared/contract.ts";

/**
 * `applyConfigPatch` 中 Clash 内核、代理、订阅与调度几节的合并。拆出来是因为它们与 Worker
 * 共享同一套规则（create → update → delete、未知 id 报 not_found、凭证三态），但各有
 * 级联与引用约束。都在 `next` 上原地修改，调用方负责深拷贝与最终的全量 `ConfigSchema`。
 */

export type SectionFailure = { kind: "not_found" | "invalid_config"; message: string };

/** 凭证三态：缺席不动、`{set}` 换值、`{clear:true}` 清空。 */
export function applySecret(current: string, patch: SecretPatch | undefined): string {
  if (patch === undefined) return current;
  if ("clear" in patch) return "";
  return patch.set;
}

/** 删一批代理前检查引用：被 Worker 绑着的代理删掉会让 Worker 静默退回直连。 */
function referencedBy(next: Config, proxyIds: ReadonlySet<string>): string[] {
  return next.workers.filter((w) => w.proxyId !== null && proxyIds.has(w.proxyId)).map((w) => w.id);
}

export function applyRoutingPatch(next: Config, patch: NonNullable<ConfigPatch["routing"]>): void {
  if (patch.strategy !== undefined) next.routing.strategy = patch.strategy;
  if (patch.affinityTtlMs !== undefined) next.routing.affinityTtlMs = patch.affinityTtlMs;
  if (patch.cooldown !== undefined) {
    for (const [key, value] of Object.entries(patch.cooldown)) {
      if (value !== undefined) next.routing.cooldown[key as keyof Config["routing"]["cooldown"]] = value;
    }
  }
}

export function applyClashPatch(
  next: Config,
  patch: NonNullable<ConfigPatch["clash"]>,
): SectionFailure | null {
  if (patch.enabled !== undefined) next.clash.enabled = patch.enabled;
  if (patch.selectionMode !== undefined) next.clash.selectionMode = patch.selectionMode;

  const b = patch.bridges;
  if (b !== undefined) {
    const deleting = new Set(b.delete ?? []);
    for (const spec of b.create ?? []) {
      if (next.clash.bridges.some((x) => x.id === spec.id) && !deleting.has(spec.id)) {
        return { kind: "invalid_config", message: `Clash 内核 id 已存在:${spec.id}` };
      }
      next.clash.bridges.push(spec);
    }

    for (const [id, bp] of Object.entries(b.update ?? {})) {
      const index = next.clash.bridges.findIndex((x) => x.id === id);
      if (index === -1) return { kind: "not_found", message: `Clash 内核不存在:${id}` };
      const current = next.clash.bridges[index]!;
      const { apiSecret, ...plain } = bp;
      const parsed = ClashBridgeSchema.safeParse({
        ...current,
        ...Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined)),
        apiSecret: applySecret(current.apiSecret, apiSecret),
      });
      if (!parsed.success) {
        // 只给路径与规则：值里可能有 secret。
        const where = parsed.error.issues.map((i) => i.path.map(String).join(".")).join(", ");
        return { kind: "invalid_config", message: `Clash 内核 ${id} 的字段不合法:${where}` };
      }
      next.clash.bridges[index] = parsed.data;
    }

    for (const id of b.delete ?? []) {
      const index = next.clash.bridges.findIndex((x) => x.id === id);
      if (index === -1) return { kind: "not_found", message: `Clash 内核不存在:${id}` };
      // 该内核导入的代理只能经它桥接，留着会违反引用完整性；被 Worker 绑着的则拒绝整个请求。
      const owned = new Set(next.proxies.filter((p) => p.bridgeId === id).map((p) => p.id));
      const users = referencedBy(next, owned);
      if (users.length > 0) {
        return {
          kind: "invalid_config",
          message: `Clash 内核 ${id} 导入的代理仍被 Worker 引用(${users.join(", ")}),请先改绑或删除这些 Worker`,
        };
      }
      next.proxies = next.proxies.filter((p) => !owned.has(p.id));
      next.clash.bridges.splice(index, 1);
      if (next.clash.activeBridgeId === id) next.clash.activeBridgeId = null;
    }
  }

  // 放在内核增删之后：同一请求里新建内核并设为当前是合法的。
  if (patch.activeBridgeId !== undefined) next.clash.activeBridgeId = patch.activeBridgeId;
  return null;
}

export function applyProxiesPatch(
  next: Config,
  patch: NonNullable<ConfigPatch["proxies"]>,
): SectionFailure | null {
  for (const [id, pp] of Object.entries(patch.update ?? {})) {
    const proxy = next.proxies.find((x) => x.id === id);
    if (proxy === undefined) return { kind: "not_found", message: `代理不存在:${id}` };
    if (pp.enabled !== undefined) proxy.enabled = pp.enabled;
    if (pp.name !== undefined) proxy.name = pp.name;
  }

  if (patch.delete !== undefined) {
    const ids = new Set(patch.delete);
    for (const id of ids) {
      if (!next.proxies.some((p) => p.id === id)) return { kind: "not_found", message: `代理不存在:${id}` };
    }
    // 显式检查而不只靠 `ConfigSchema` 的引用校验：那条错误只给路径，看不出是哪个 Worker。
    const users = referencedBy(next, ids);
    if (users.length > 0) {
      return {
        kind: "invalid_config",
        message: `代理仍被 Worker 引用(${users.join(", ")}),请先改绑或删除这些 Worker`,
      };
    }
    next.proxies = next.proxies.filter((p) => !ids.has(p.id));
  }
  return null;
}

export function applySubscriptionsPatch(
  next: Config,
  patch: NonNullable<ConfigPatch["subscriptions"]>,
): SectionFailure | null {
  const deleting = new Set(patch.delete ?? []);
  for (const spec of patch.create ?? []) {
    if (next.subscriptions.some((x) => x.id === spec.id) && !deleting.has(spec.id)) {
      return { kind: "invalid_config", message: `订阅 id 已存在:${spec.id}` };
    }
    // 过存储 schema 补齐 lastFetchedAt 等状态字段的默认值。
    next.subscriptions.push(SubscriptionSchema.parse(spec));
  }

  for (const [id, sp] of Object.entries(patch.update ?? {})) {
    const sub = next.subscriptions.find((x) => x.id === id);
    if (sub === undefined) return { kind: "not_found", message: `订阅不存在:${id}` };
    if (sp.name !== undefined) sub.name = sp.name;
    if (sp.enabled !== undefined) sub.enabled = sp.enabled;
    // 清空 URL 会被全量 schema 拒绝（url 必填），效果等同报错，这是预期的。
    if (sp.url !== undefined) sub.url = applySecret(sub.url, sp.url);
  }

  for (const id of patch.delete ?? []) {
    const index = next.subscriptions.findIndex((x) => x.id === id);
    if (index === -1) return { kind: "not_found", message: `订阅不存在:${id}` };
    const owned = new Set(next.proxies.filter((p) => p.subscriptionId === id).map((p) => p.id));
    const users = referencedBy(next, owned);
    if (users.length > 0) {
      return {
        kind: "invalid_config",
        message: `订阅 ${id} 导入的代理仍被 Worker 引用(${users.join(", ")}),请先改绑或删除这些 Worker`,
      };
    }
    next.proxies = next.proxies.filter((p) => !owned.has(p.id));
    next.subscriptions.splice(index, 1);
  }
  return null;
}
