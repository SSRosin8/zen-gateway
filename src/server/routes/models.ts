import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import { judgeFree } from "../../core/models/free.ts";
import type { UpstreamDeps } from "../../core/upstream/fetch.ts";
import { ModelCatalog, catalogIdentityOf, slotOf } from "../../core/models/catalog.ts";
import { gatewayError } from "../middleware/errorMap.ts";
import { MODELS_PATHS } from "../../core/protocols/chat.ts";

/**
 * `/v1/models` —— 目录查询。
 *
 * ## 这里**过滤**而不透传,是刻意的
 *
 * 转发面严格原样透传,但目录是个例外:本网关只放行免费模型,若把上游完整目录
 * 原样报给 OpenCode,它会把付费模型也列进可选项,用户一选就得到 403。
 * 客户端能看到的模型集必须与网关实际放行的集合一致 —— 否则每个付费模型
 * 都是一个「看起来能用,点了报错」的陷阱。
 *
 * ## 为什么读 body 在这里是允许的
 *
 * 不变量 #1 约束的是**转发链路**:那里读 body 会导致「发过字节后又重试」。
 * 目录查询不在那条链路上 —— 它非流式、响应只有几 KB、且本就需要解析内容
 * 才能过滤。这个区别值得写明,免得后来者照抄到转发链路上。
 *
 * ## Phase 6 接管的部分:缓存
 *
 * 先前这里**每次请求都打一次上游**,于是上游抖动时目录跟着消失 ——
 * 而目录为空等于免费集为空,等于 OpenCode 的模型列表整个空掉。
 * 现在走 `ModelCatalog`:校验过的最后成功缓存、失败时继续用旧的、
 * 旧的永不硬过期。见那个文件的说明。
 *
 * 身份槽位也在那里:目录**按「带 key／免 key」区分**(实测两个账号看到的
 * 差异项完全相同,所以不是 per-Worker)。这里只负责选一个身份并把结果过滤。
 */

export type ModelsDeps = {
  readonly configOf: () => Config;
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  /** 在架目录缓存。与转发面**共用同一个** —— 见 `app.ts`。 */
  readonly catalog: ModelCatalog;
  readonly log?: (message: string) => void;
};

export function createModelsRoutes(deps: ModelsDeps): Hono {
  const app = new Hono();
  for (const path of MODELS_PATHS) {
    app.get(path, (c) => handleModels(c, deps));
  }
  return app;
}

/**
 * 目录查询。
 *
 * 身份怎么选见 `catalogIdentityOf` —— 那条知识连同"刻意不经调度器"的理由
 * 都在它那里,三个调用点共用一份,不在这里再写一遍。
 *
 * 这里用 `ensure`(而非 `refreshIfStale`)是因为这条路径**可以等**:
 * 用户主动在问目录,一次几百毫秒的上游查询是他预期中的事。转发路径相反 ——
 * 见 `relay.ts` 第 3 步的说明。
 */
async function handleModels(c: Context, deps: ModelsDeps): Promise<Response> {
  const config = deps.configOf();
  const identity = catalogIdentityOf(config);

  const snapshot = await deps.catalog.ensure(identity, config, deps.upstreamOf);
  if (snapshot === null) {
    /*
     * 从来没成功拉到过目录。
     *
     * 502 而非空列表:一个空的 `{"data":[]}` 会让 OpenCode 显示"没有可用模型",
     * 而那与"网关拿不到目录"是两件事 —— 用户会去翻自己的模型配置,
     * 而真实原因是上游或出口不通。
     */
    return c.json(gatewayError("upstream_unreachable", "无法获取上游模型目录"), 502);
  }

  /*
   * 过滤成免费集。保留上游条目的其余字段原样 ——
   * 客户端可能依赖 `created`/`owned_by`,重建对象会丢掉我们没预料到的字段。
   *
   * 这里把 snapshot 同时当作"待过滤的条目"与"求交集的在架集合"。
   * 两者同源,所以交集在这条路径上恒为真 —— 但仍然传进去:
   * `judgeFree` 的签名若在这里能省掉目录,下一个调用点就会照抄这个省法。
   */
  const free = snapshot.entries.filter((entry) => judgeFree(entry.id, config.models, snapshot).free);

  return c.json({
    object: "list",
    data: free,
    /*
     * 网关自己的诊断字段,不属于 OpenAI 契约。
     *
     * 放在体里而不是头里:用户看目录时最想知道的是"这份是不是刚拉的",
     * 而 OpenCode 不会显示响应头。名字加 `zen_gateway_` 前缀,
     * 免得哪天上游真加了同名字段。
     */
    zen_gateway_catalog: {
      slot: slotOf(identity),
      total: snapshot.entries.length,
      free: free.length,
      fetched_at: snapshot.fetchedAt,
      fresh: deps.catalog.isFresh(snapshot, config, Date.now()),
    },
  });
}
