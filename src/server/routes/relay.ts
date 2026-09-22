import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import type { ProtocolRegistry } from "../../core/protocols/registry.ts";
import type { ProtocolSurface } from "../../core/protocols/types.ts";
import { judgeFree } from "../../core/models/free.ts";
import { buildUpstreamHeaders } from "../../core/upstream/headers.ts";
import { upstreamUrl } from "../../core/upstream/url.ts";
import type { UpstreamDeps } from "../../core/upstream/fetch.ts";
import { runRetryChain, type AttemptTarget } from "../../core/upstream/retry.ts";
import { pipeUpstreamResponse } from "../../core/upstream/pipe.ts";
import { describeNoWorker, selectTargets } from "../../core/routing/select.ts";
import {
  errorBodyFromException,
  gatewayError,
  logMessageFor,
  statusForGatewayError,
  typeForFailureKind,
} from "../middleware/errorMap.ts";

/**
 * 转发面路由。
 *
 * ## 处理顺序,以及为什么是这个顺序
 *
 *   1. 读**原始请求体字节**(只读一次)
 *   2. 解析一份**副本**用于判定(模型、是否流式)
 *   3. 免费判定 —— 不通过则在**请求出去之前**拒绝
 *   4. 选 Worker
 *   5. 重试链(只看 status+headers,body 不消费)
 *   6. 流式透传(唯一写字节的地方)
 *
 * 第 1 与第 2 步分开是「原样透传」的要求:转发出去的必须是客户端发来的原始
 * 字节。实测 `JSON.parse` → `stringify` 往返**不是无损的**
 * (`{"n":1.0}` → `{"n":1}`),而这个网关的存在意义就是让 OpenCode 像直连
 * 上游一样工作 —— 我们不该引入任何客户端察觉得到的差异。
 *
 * 第 3 步必须在第 5 步之前:放行一个付费模型的代价是真金白银,
 * 而它一旦发出去就无法收回。
 */

export type RelayDeps = {
  /** 读当前配置。做成函数以便配置热更新后立即生效。 */
  readonly configOf: () => Config;
  readonly registry: ProtocolRegistry;
  /** 上游依赖(dispatcher 池、锁、Controller)。 */
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  /** 注入以便测试。 */
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
};

/** 客户端请求体上限。转发面对多模态保持宽松,但不能无界。 */
const MAX_RELAY_BODY_BYTES = 64 * 1024 * 1024;

export function createRelayRoutes(deps: RelayDeps): Hono {
  const app = new Hono();

  /*
   * 路由从注册表动态挂载 —— 这正是「新增一个面不动路由装配」的兑现。
   * 若这里出现 `app.post("/v1/chat/completions", ...)` 这样的字面量,
   * 注册表就失去了意义。
   */
  for (const path of deps.registry.paths()) {
    app.post(path, async (c) => {
      const surface = deps.registry.byPath(path);
      if (surface === null) {
        // 理论不可达:path 来自注册表自身。保留是为了不用 `!`。
        return c.json(gatewayError("internal_error", "协议面查找失败"), 500);
      }
      return handleRelay(c, surface, deps);
    });
  }

  return app;
}

type HonoContext = Context;

async function handleRelay(
  c: HonoContext,
  surface: ProtocolSurface,
  deps: RelayDeps,
): Promise<Response> {
  const config = deps.configOf();

  /* ---- 1. 读原始字节(只读一次) ---- */
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await c.req.arrayBuffer());
  } catch (err) {
    deps.log?.(`读取请求体失败: ${logMessageFor(err)}`);
    return c.json(gatewayError("invalid_request", "无法读取请求体"), 400);
  }

  if (raw.byteLength > MAX_RELAY_BODY_BYTES) {
    return c.json(gatewayError("invalid_request", "请求体超过上限"), 413);
  }
  if (raw.byteLength === 0) {
    return c.json(gatewayError("invalid_request", "请求体为空"), 400);
  }

  /* ---- 2. 解析副本用于判定(绝不用它重建转发体) ---- */
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // 不回显原始体:它可能很大,也可能含用户的对话内容。
    return c.json(gatewayError("invalid_request", "请求体不是合法 JSON"), 400);
  }

  const model = surface.extractModel(parsed);
  if (model === null) {
    return c.json(
      gatewayError("invalid_request", "请求体缺少合法的 model 字段"),
      400,
    );
  }

  /* ---- 3. 免费判定(在请求出去之前) ---- */
  const verdict = judgeFree(model, config.models);
  if (!verdict.free) {
    /*
     * 消息里带上模型 id。
     *
     * 这与「校验消息不回显用户数据」不冲突:模型 id 是客户端自己刚发来的、
     * 且是公开目录里的标识,不是凭证也不是他人数据。而没有它这条错误就无法自查
     * —— 用户看到「模型不允许」却不知道是哪个模型被拒。
     */
    return c.json(
      gatewayError(
        "model_not_allowed",
        `模型 ${model} 不在免费集内。本网关只放行免费模型;可在配置的 models.extraFreeIds 中调整`,
      ),
      403,
    );
  }

  /* ---- 4. 选 Worker ---- */
  const targets: AttemptTarget[] = selectTargets(config);
  if (targets.length === 0) {
    return c.json(
      gatewayError("no_worker_available", describeNoWorker(config)),
      503,
    );
  }

  const streaming = surface.wantsStream(parsed);
  const clientHeaders = c.req.header();

  /* ---- 5. 重试链 ---- */
  let result;
  try {
    result = await runRetryChain({
      targets,
      maxAttempts: config.gateway.maxAttempts,
      url: upstreamUrl(config.gateway.baseUrl, surface.upstreamPath),
      method: "POST",
      body: raw,
      deps: deps.upstreamOf(config),
      buildHeaders: (target) =>
        buildUpstreamHeaders({
          clientHeaders,
          apiKey: target.apiKey,
          streaming,
          extra: surface.extraUpstreamHeaders({ apiKey: target.apiKey, streaming }),
          ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
        }),
    });
  } catch (err) {
    // buildHeaders 抛的 HeaderValidationError 会走到这里 —— 那是 400。
    const mapped = errorBodyFromException(err);
    deps.log?.(`转发失败: ${logMessageFor(err)}`);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  /* ---- 6. 透传 ---- */

  /*
   * 透传包一层兜底。
   *
   * `pipeUpstreamResponse` 现在内部对畸形头容错,理论上不抛;但这里是
   * **上游已经成功之后**的位置,一旦抛异常后果特别糟:客户端拿到裸 500
   * (不是我们的 JSON 错误形状)、上游那次请求已真实计入额度、
   * 响应体流既不转发也不释放(连接泄漏),而且 `deps.log` 完全不被调用 ——
   * 异常绕过所有日志路径,故障现场什么都不留。
   *
   * 所以即便 pipe 自己已经容错,这层兜底仍然要在:它保证"无论如何 body
   * 都被处置、错误都被记录"。
   */
  const pipeOrFail = (
    upstream: NonNullable<typeof result.response>,
    extra: Record<string, string>,
  ): Response => {
    try {
      return pipeUpstreamResponse(upstream, extra);
    } catch (err) {
      // 释放上游连接 —— 不释放会让它悬挂到超时。
      void upstream.body?.cancel().catch(() => {});
      deps.log?.(`响应透传失败(上游已成功): ${logMessageFor(err)}`);
      return c.json(
        gatewayError("internal_error", "网关无法转发上游响应,详见服务端日志"),
        500,
      );
    }
  };

  if (result.ok) {
    return pipeOrFail(result.response, {
      // 诊断头:这次由哪个 Worker 承接。便于用户核对出口隔离是否按预期生效。
      "x-zen-gateway-worker": result.workerId,
    });
  }

  /*
   * 失败但**拿到了上游响应** —— 原样透传。
   *
   * 客户端应当看到上游真实的错误负载(429 的 retry-after 说明、
   * 400 的字段级报错),而不是网关的转述。这也是唯一能让用户看到
   * 上游真实拒绝原因(例如 FreeTierError)的路径。
   */
  if (result.response !== null) {
    return pipeOrFail(result.response, {
      "x-zen-gateway-attempts": String(result.attempts.length),
    });
  }

  /*
   * 连响应头都没拿到:网关自造错误。
   *
   * 出口配置失败要单独报 `egress_unavailable`(503),不能跟着 `bad_request`
   * 走 400。「代理已停用」「Clash 没开」都是**本机配置**问题,客户端的请求
   * 完全合法 —— 报 400「请求无效」会让用户去检查请求体,而真实原因在配置里。
   * 更糟的是 OpenCode 这类客户端把 4xx 当作自己的错,不会重试。
   */
  const type = result.egressSetup ? "egress_unavailable" : typeForFailureKind(result.kind);
  deps.log?.(`转发失败(${result.egressSetup ? "出口配置" : result.kind}): ${result.reason}`);
  return c.json(
    gatewayError(type, `上游请求失败:${result.reason}`),
    statusForGatewayError(type) as 400 | 500 | 502 | 503,
  );
}
