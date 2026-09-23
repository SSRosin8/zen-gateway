import type { ModelRules } from "../../shared/schema.ts";

/**
 * 免费模型放行判定 —— Phase 3 的最小基线。
 *
 * ## 判定规则(配置驱动)
 *
 * 免费 = 后缀命中 `freeSuffix` **或** 在 `extraFreeIds` 名单里。
 *
 * 旧项目把等价名单写成代码常量(`SPECIAL_FREE_MODEL_IDS`),目录一变就要
 * 改代码发版,而它硬编码的 `union-alpha` 已从上游目录消失。这里全部读配置。
 *
 * ## 与 Phase 6 的边界:这一版**没有**与在架目录求交集
 *
 * 完整判定应当是「（后缀命中 ∪ extraFreeIds）∩ 在架目录」,交集那一步
 * 能让已下架的 id 自动失效。但它需要联网拉 `GET {baseUrl}/models` 并维护
 * 「校验过的最后成功缓存」,那是 Phase 6 的内容。
 *
 * 少了交集的后果是**放得偏宽**:一个已下架的 `xxx-free` 会被本网关放行,
 * 然后由上游拒绝。
 *
 * **这里先前写的是推测,且推测错了**:原文说上游返回 404、经 `classifyStatus`
 * 归为 `auth`、表现为「换 Worker 重试后仍失败」。2026-09-22 用真实 key 实测的
 * 真实行为是 **400 `Upstream request failed: Model is unavailable.`** →
 * 归为 `bad_request` → **不重试、不归咎 Worker、原样透传**。
 * 这比推测的行为好(一个客户端的坏模型名不会把健康 Worker 打进冷却,
 * 正是不变量 #4 要保的那件事),但缺口本身仍在:错误由上游措辞给出,
 * 用户看到的是「模型不可用」而不是「这个模型不在本网关的免费集里」。
 *
 * 另有一个**免 key 时**才出现的形态(2026-09-23 实测):同一个已下架 id 得到
 * **401 `ModelError: Model glm-5-free is not supported`** —— 上游把 401 同时
 * 用于鉴权失败与模型不存在。这条路径转发链走不到(`selectTargets` 保证
 * 每个候选都有 key),但它说明**不能假定 401 一定是凭证问题**;
 * 若上游哪天在带 key 的请求上也这么返回,401 → `auth` → `shouldCooldown` 为真,
 * 一个坏模型名就会连累健康 Worker。Phase 6 补上交集正好也消掉这个暴露面。
 *
 * Phase 6 必须补上交集。
 *
 * ## 为什么默认拒绝
 *
 * 判定不出「确定免费」就拒绝。这个网关的存在前提是只用免费模型,
 * 放行一个付费模型的代价是真金白银,而拒绝一个免费模型的代价只是
 * 一条可自查的错误信息 —— 两侧代价不对称,所以默认必须是拒绝。
 */

export type FreeVerdict =
  | { free: true; reason: "suffix" | "extra" }
  | { free: false; reason: "not_free" };

/**
 * 判断一个模型 id 是否属于免费集。
 *
 * `modelId` 必须是调用方已校验过的非空、无首尾空白的字符串
 * (见 `protocols/types.ts` 的 `readModelField`)。这里不再 trim 或改大小写:
 * 任何归一化都会让「网关认为的 id」与「发给上游的 id」产生分歧,
 * 而那个分歧就是一个放行漏洞。
 */
export function judgeFree(modelId: string, rules: ModelRules): FreeVerdict {
  /*
   * 先查显式名单,再看后缀。
   *
   * 顺序无关正确性(两者都为真时都是 free),但 reason 会不同,
   * 而 reason 会进诊断输出 —— 「因为在名单里」比「因为后缀」更有助于
   * 用户理解为何某个无后缀模型被放行。
   */
  if (rules.extraFreeIds.includes(modelId)) return { free: true, reason: "extra" };

  /*
   * 后缀判定要求「以后缀结尾且不等于后缀本身」。
   *
   * 少了后半个条件,一个恰好叫 `-free` 的模型 id 会被放行;更要紧的是
   * 若用户把 `freeSuffix` 误配成空串,`endsWith("")` 对**任何** id 都为真,
   * 整道闸门会静默全开。schema 已用 `.min(1)` 挡住空串,这里是第二道 ——
   * 一个「配置写错就全开」的闸门不该只有一层防护。
   */
  const suffix = rules.freeSuffix;
  if (suffix !== "" && modelId !== suffix && modelId.endsWith(suffix)) {
    return { free: true, reason: "suffix" };
  }

  return { free: false, reason: "not_free" };
}

/** 该模型在本网关上支持哪些协议面(读配置的覆写表,回落到默认)。 */
export function surfacesFor(modelId: string, rules: ModelRules): readonly string[] {
  return rules.surfaceOverrides[modelId] ?? rules.defaultSurfaces;
}
