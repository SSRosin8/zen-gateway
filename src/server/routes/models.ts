import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import { judgeFree } from "../../core/models/free.ts";
import type { UpstreamDeps } from "../../core/upstream/fetch.ts";
import { ModelCatalog, catalogIdentitiesOf, slotOf } from "../../core/models/catalog.ts";
import { gatewayError } from "../middleware/errorMap.ts";
import { MODELS_PATHS } from "../../core/protocols/chat.ts";

/**
 * `/v1/models` 目录查询。刻意过滤成免费集而不透传：客户端能看到的模型集必须
 * 与网关实际放行的一致，否则付费模型都是「点了报 403」的陷阱。
 * 这里读 body 不违反不变量 #1：它不在转发链路上，且本就需要解析内容。
 * 缓存与身份槽位见 `ModelCatalog`（`catalog.ts`），这里不存第二份结论。
 */

export type ModelsDeps = {
  readonly configOf: () => Config;
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  /** 在架目录缓存，与转发面共用同一个（见 `app.ts`）。 */
  readonly catalog: ModelCatalog;
};

export function createModelsRoutes(deps: ModelsDeps): Hono {
  const app = new Hono();
  for (const path of MODELS_PATHS) {
    app.get(path, (c) => handleModels(c, deps));
  }
  return app;
}

/**
 * 身份选择见 `catalogIdentityOf`。这里用 `ensure` 而非 `refreshIfStale`：
 * 用户主动查询目录时可以等一次上游请求，转发路径则不行。
 */
async function handleModels(c: Context, deps: ModelsDeps): Promise<Response> {
  const config = deps.configOf();
  const identities = catalogIdentitiesOf(config);
  let identity = identities[0]!;
  let snapshot = null;

  for (const candidate of identities) {
    identity = candidate;
    snapshot = await deps.catalog.ensure(candidate, config, deps.upstreamOf);
    if (snapshot !== null) break;
  }
  if (snapshot === null) {
    // 从未拉到过目录时报 502 而非空列表：空列表会让用户去翻自己的模型配置。
    return c.json(gatewayError("upstream_unreachable", "无法获取上游模型目录"), 502);
  }

  /*
   * 过滤成免费集，保留上游条目其余字段原样。snapshot 同时作为在架集合传入，
   * 虽然交集在此恒为真，但不给后来的调用点留下省略目录的范例。
   */
  const free = snapshot.entries.filter((entry) => judgeFree(entry.id, config.models, snapshot).free);

  return c.json({
    object: "list",
    data: free,
    // 网关自己的诊断字段（不属于 OpenAI 契约），放体里因为 OpenCode 不显示响应头。
    zen_gateway_catalog: {
      slot: slotOf(identity),
      total: snapshot.entries.length,
      free: free.length,
      fetched_at: snapshot.fetchedAt,
      // 不传 `now`：用 `ModelCatalog` 自己的时钟，与 `fetched_at` 同一时间源。
      fresh: deps.catalog.isFresh(snapshot, config),
    },
  });
}
