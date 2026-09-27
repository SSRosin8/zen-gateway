import type { ModelRules } from "../../shared/schema.ts";

/**
 * 免费模型放行判定（配置驱动）。
 *
 * 免费 =（后缀命中 `freeSuffix` 或在 `extraFreeIds` 名单）∩ 在架目录。
 * 交集让已下架的 `xxx-free` 在网关侧就被拒，并给出本网关的措辞，而不是依赖上游
 * 返回的 400/401（上游会把 401 同时用于鉴权失败与模型不存在）。
 *
 * 判定不出「确定免费」就拒绝：放行付费模型花真钱，误拒只是一条可自查的错误。
 * 但目录缺失时放行（仍有后缀／名单依据，不在架只会被上游拒、不产生费用），
 * 否则一次上游抖动就让网关拒绝一切；此时用 `*_unverified` reason 标明没做交集。
 */

export type FreeVerdict =
  | { free: true; reason: "suffix" | "extra" }
  /** 免费依据成立，但目录不可用，没做交集。 */
  | { free: true; reason: "suffix_unverified" | "extra_unverified" }
  | { free: false; reason: "not_free" }
  /** 免费依据成立,但已不在上游在架目录里。 */
  | { free: false; reason: "retired" };

/** 判定时可选的在架目录。`null` 表示当前拿不到 —— 此时不做交集。 */
export type CatalogView = {
  readonly ids: ReadonlySet<string>;
} | null;

/**
 * 判断模型 id 是否属于免费集。`modelId` 须已经 `readModelField` 校验；这里不再归一化，
 * 否则「网关认为的 id」与「发给上游的 id」分歧即放行漏洞。
 */
export function judgeFree(
  modelId: string,
  rules: ModelRules,
  catalog: CatalogView = null,
): FreeVerdict {
  // 先查名单再看后缀：结果相同，但 reason 进诊断，「在名单里」更有助于理解。
  const basis: "extra" | "suffix" | null = rules.extraFreeIds.includes(modelId)
    ? "extra"
    : // 后缀不能等于自身；空串守卫是 schema `.min(1)` 之外的第二道，防止闸门全开。
      rules.freeSuffix !== "" &&
        modelId !== rules.freeSuffix &&
        modelId.endsWith(rules.freeSuffix)
      ? "suffix"
      : null;

  if (basis === null) return { free: false, reason: "not_free" };

  // 交集被关掉或目录拿不到，退回只看后缀与名单。
  if (!rules.enforceCatalog) return { free: true, reason: basis };
  if (catalog === null) {
    return { free: true, reason: basis === "extra" ? "extra_unverified" : "suffix_unverified" };
  }

  if (!catalog.ids.has(modelId)) return { free: false, reason: "retired" };
  return { free: true, reason: basis };
}
