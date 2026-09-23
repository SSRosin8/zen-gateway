import type { ModelRules } from "../../shared/schema.ts";

/**
 * 免费模型放行判定。
 *
 * ## 判定规则(配置驱动)
 *
 * 免费 = （后缀命中 `freeSuffix` **或** 在 `extraFreeIds` 名单里）**∩ 在架目录**。
 *
 * 旧项目把等价名单写成代码常量(`SPECIAL_FREE_MODEL_IDS`),目录一变就要
 * 改代码发版,而它硬编码的 `union-alpha` 已从上游目录消失。这里全部读配置。
 *
 * ## 交集这一步(Phase 6 补上的)
 *
 * 少了交集会**放得偏宽**:一个已下架的 `xxx-free` 后缀命中于是被放行,
 * 然后由上游拒绝。实测(2026-09-22,真实 key)真实行为是
 * **400 `Upstream request failed: Model is unavailable.`** → 归为
 * `bad_request` → 不重试、不归咎 Worker、原样透传。
 *
 * > 这里先前写的是推测且推测错了:原文说上游返回 404、经 `classifyStatus`
 * > 归为 `auth`、表现为「换 Worker 重试后仍失败」。实测行为比推测的**更好**
 * > (不会把健康 Worker 打进冷却,正是不变量 #4 要保的那件事),但缺口仍在:
 * > 用户看到的是上游措辞「模型不可用」,而不是「这个模型不在本网关的免费集里」。
 *
 * 交集还消掉一个**暴露面**:免 key 时同一个已下架 id 得到
 * **401 `ModelError: Model glm-5-free is not supported`** —— 上游把 401 同时
 * 用于鉴权失败与模型不存在。转发链走不到那条路径(每个候选都有 key),
 * 但它说明**不能假定 401 一定是凭证问题**;若上游哪天在带 key 的请求上也这么
 * 返回,401 → `auth` → `shouldCooldown` 为真,一个坏模型名就会连累健康 Worker。
 *
 * ## 目录缺失时**放行**,不是拒绝
 *
 * 这与下面"默认拒绝"的取向看似冲突,其实不是同一个判断:
 *
 * - **默认拒绝**针对的是「判定不出这个模型免费」—— 放行的代价是真金白银。
 * - **目录缺失**时我们对这个模型仍有一个独立依据(后缀／名单),缺的只是
 *   「它是否还在架」。而"不在架"的唯一后果是**上游拒绝**(见上文 400),
 *   不产生费用。
 *
 * 若这里改成拒绝,一次上游抖动就会让网关拒绝**一切**请求 —— 用一个
 * 不花钱的风险换一次全面不可用。所以缺目录时退回 Phase 5 的行为,
 * 并用一个单独的 `reason` 让诊断能看出这次没做交集。
 *
 * ## 为什么默认拒绝
 *
 * 判定不出「确定免费」就拒绝。这个网关的存在前提是只用免费模型,
 * 放行一个付费模型的代价是真金白银,而拒绝一个免费模型的代价只是
 * 一条可自查的错误信息 —— 两侧代价不对称,所以默认必须是拒绝。
 */

export type FreeVerdict =
  | { free: true; reason: "suffix" | "extra" }
  /** 免费依据成立,但目录不可用,没做交集 —— 见文件头。 */
  | { free: true; reason: "suffix_unverified" | "extra_unverified" }
  | { free: false; reason: "not_free" }
  /** 免费依据成立,但已不在上游在架目录里。 */
  | { free: false; reason: "retired" };

/** 判定时可选的在架目录。`null` 表示当前拿不到 —— 此时不做交集。 */
export type CatalogView = {
  readonly ids: ReadonlySet<string>;
} | null;

/**
 * 判断一个模型 id 是否属于免费集。
 *
 * `modelId` 必须是调用方已校验过的非空、无首尾空白的字符串
 * (见 `protocols/types.ts` 的 `readModelField`)。这里不再 trim 或改大小写:
 * 任何归一化都会让「网关认为的 id」与「发给上游的 id」产生分歧,
 * 而那个分歧就是一个放行漏洞。
 */
export function judgeFree(
  modelId: string,
  rules: ModelRules,
  catalog: CatalogView = null,
): FreeVerdict {
  /*
   * 先查显式名单,再看后缀。
   *
   * 顺序无关正确性(两者都为真时都是 free),但 reason 会不同,
   * 而 reason 会进诊断输出 —— 「因为在名单里」比「因为后缀」更有助于
   * 用户理解为何某个无后缀模型被放行。
   */
  const basis: "extra" | "suffix" | null = rules.extraFreeIds.includes(modelId)
    ? "extra"
    : /*
       * 后缀判定要求「以后缀结尾且不等于后缀本身」。
       *
       * 少了后半个条件,一个恰好叫 `-free` 的模型 id 会被放行;更要紧的是
       * 若用户把 `freeSuffix` 误配成空串,`endsWith("")` 对**任何** id 都为真,
       * 整道闸门会静默全开。schema 已用 `.min(1)` 挡住空串,这里是第二道 ——
       * 一个「配置写错就全开」的闸门不该只有一层防护。
       */
      rules.freeSuffix !== "" &&
        modelId !== rules.freeSuffix &&
        modelId.endsWith(rules.freeSuffix)
      ? "suffix"
      : null;

  if (basis === null) return { free: false, reason: "not_free" };

  // 交集被关掉,或目录拿不到 —— 退回"只看后缀与名单"。
  if (!rules.enforceCatalog) return { free: true, reason: basis };
  if (catalog === null) {
    return { free: true, reason: basis === "extra" ? "extra_unverified" : "suffix_unverified" };
  }

  if (!catalog.ids.has(modelId)) return { free: false, reason: "retired" };
  return { free: true, reason: basis };
}

/**
 * 该模型在本网关上支持哪些协议面(读配置的覆写表,回落到默认)。
 *
 * ## ⚠️ 本函数**没有生产调用点**,而且不要顺手补一个
 *
 * 它与 `models.defaultSurfaces` / `surfaceOverrides` 一起,是第四轮审核那个
 * `streaming` 字段的同形态:声明了、有单测、但全仓没有一处读它。
 *
 * 按纪律 #1 的四分类,这看起来该归"代码里有死信息"。但**先别改**:
 * `defaultSurfaces` 的默认值是 `["chat", "responses"]`,若把它当放行闸门接上,
 * 默认配置下**所有**模型的 `/v1/messages` 请求都会被拒 —— 而那个面 Phase 6
 * 刚验证可用。也就是说"补上这个判定"会立刻打坏一个能用的功能。
 *
 * 真正缺的是**语义定义**:这两张表是「放行闸门」还是「后台展示用的提示」?
 * 上游并不按模型区分面(三个面对同一个免费模型都通),所以当闸门用缺乏依据。
 * 眼下按后者处理 —— 保留数据与函数,不参与判定,并在
 * `docs/architecture.md` 的缺口清单里记着(Phase 9 的 Models 页要用它)。
 */
export function surfacesFor(modelId: string, rules: ModelRules): readonly string[] {
  return rules.surfaceOverrides[modelId] ?? rules.defaultSurfaces;
}
