import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import { judgeFree } from "../../core/models/free.ts";
import { upstreamUrl } from "../../core/upstream/url.ts";
import type { UpstreamDeps } from "../../core/upstream/fetch.ts";
import { fetchUpstream } from "../../core/upstream/fetch.ts";
import { buildUpstreamHeaders } from "../../core/upstream/headers.ts";
import { usableTargets } from "../../core/routing/select.ts";
import { classifyStatus } from "../../core/failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
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
 * ## Phase 6 会接管的部分
 *
 * 这一版每次请求都打一次上游。Phase 6 要加「启动预热 + 定时刷新 +
 * 校验过的最后成功缓存」,那样上游抖动时目录不会跟着消失。
 */

export type ModelsDeps = {
  readonly configOf: () => Config;
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  readonly log?: (message: string) => void;
};

/** 上游目录条目。只认 id 是字符串的条目,其余字段原样保留。 */
type ModelEntry = { id: string } & Record<string, unknown>;

function isModelEntry(value: unknown): value is ModelEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

export function createModelsRoutes(deps: ModelsDeps): Hono {
  const app = new Hono();
  for (const path of MODELS_PATHS) {
    app.get(path, (c) => handleModels(c, deps));
  }
  return app;
}

async function handleModels(c: Context, deps: ModelsDeps): Promise<Response> {
  const config = deps.configOf();

  /*
   * 目录查询用第一个可用 Worker 的 key。
   *
   * 不走重试链,也**不经调度器**:目录是幂等的只读查询,失败直接如实报错比
   * 换 Worker 重试更容易定位问题。更要紧的是不共享冷却状态 —— 让一次目录
   * 查询失败把 Worker 打进冷却,等于**一个只读查询改变了转发的候选顺序**,
   * 而用户完全看不出这两件事有关系。
   *
   * 没有 Worker 时仍尝试一次无 key 请求 —— 有些上游的目录端点免鉴权可读
   * (实测 Zen 如此),那种情况下首次配置前也能看到目录,对「方便简单」
   * 有实际帮助。
   */
  const targets = usableTargets(config);
  const apiKey = targets[0]?.apiKey ?? "";
  const proxyId = targets[0]?.proxyId ?? null;

  let upstream;
  try {
    upstream = await fetchUpstream(
      {
        url: upstreamUrl(config.gateway.baseUrl, "/models"),
        method: "GET",
        headers: buildUpstreamHeaders({
          clientHeaders: {},
          apiKey,
          streaming: false,
        }),
        body: null,
        proxyId,
      },
      deps.upstreamOf(config),
    );
  } catch (err) {
    deps.log?.(`目录查询失败: ${safeErrorMessage(err)}`);
    return c.json(gatewayError("upstream_unreachable", "无法获取上游模型目录"), 502);
  }

  const failure = classifyStatus({ status: upstream.status, headers: upstream.headers });
  if (failure !== null) {
    await upstream.body?.cancel().catch(() => {});
    deps.log?.(`目录查询返回 ${upstream.status}`);
    return c.json(
      gatewayError("upstream_unreachable", `上游目录返回 ${upstream.status}`),
      502,
    );
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch (err) {
    deps.log?.(`目录响应解析失败: ${safeErrorMessage(err)}`);
    return c.json(gatewayError("upstream_unreachable", "上游目录不是合法 JSON"), 502);
  }

  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return c.json(gatewayError("upstream_unreachable", "上游目录缺少 data 数组"), 502);
  }

  /*
   * 过滤成免费集。保留上游条目的其余字段原样 ——
   * 客户端可能依赖 `created`/`owned_by`,重建对象会丢掉我们没预料到的字段。
   */
  const free = data
    .filter(isModelEntry)
    .filter((entry) => judgeFree(entry.id, config.models).free);

  return c.json({ object: "list", data: free });
}
