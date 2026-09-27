import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import type { ProtocolRegistry } from "../../core/protocols/registry.ts";
import type { ProtocolSurface } from "../../core/protocols/types.ts";
import { judgeFree } from "../../core/models/free.ts";
import { ModelCatalog, catalogIdentityOf, slotOf } from "../../core/models/catalog.ts";
import { createUsageCollector, describeUsage, type TokenUsage } from "../../core/models/usage.ts";
import { redactText, safeErrorMessage } from "../../shared/redact.ts";
import { BodyTooLargeError, readBoundedBody } from "../boundedBody.ts";
// 拒绝原因联合类型取自 stats.ts，不另定义一份（纪律 #4）。
import type { RejectionReason } from "../../store/db/stats.ts";
import { buildUpstreamHeaders } from "../../core/upstream/headers.ts";
import { upstreamUrl } from "../../core/upstream/url.ts";
import type { UpstreamDeps } from "../../core/upstream/fetch.ts";
import { runRetryChain, type AttemptTarget } from "../../core/upstream/retry.ts";
import { pipeUpstreamResponse } from "../../core/upstream/pipe.ts";
import { createOverlapScanner } from "../../core/upstream/tap.ts";
import { describeNoWorker, sessionHashFrom } from "../../core/routing/select.ts";
import type { Scheduler } from "../../core/routing/scheduler.ts";
import {
  containsStaleReasoning,
  digestOf,
  extractBlobHashes,
  STALE_PATTERN_WINDOW,
} from "../../core/routing/affinity.ts";
import {
  errorBodyFromException,
  gatewayError,
  statusForGatewayError,
  typeForFailureKind,
} from "../middleware/errorMap.ts";

/**
 * 转发面路由。处理顺序：
 *   1. 读原始请求体字节（只读一次） 2. 解析副本用于判定 3. 免费判定
 *   4. 流式能力校验 5. 选 Worker 6. 重试链（只看 status+headers） 7. 流式透传
 *
 * 1、2 分开：转发的必须是客户端原始字节，`JSON.parse`→`stringify` 不无损。
 * 3、4 在 6 之前：请求本身的问题本机即可定论；放行付费模型的代价无法收回。
 */

export type RelayDeps = {
  /** 读当前配置；做成函数以便热更新立即生效。 */
  readonly configOf: () => Config;
  readonly registry: ProtocolRegistry;
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  /** 进程内唯一：两个调度器意味着两份冷却状态。 */
  readonly scheduler: Scheduler;
  /** 与 `/v1/models` 共用的在架目录；转发路径只读缓存，绝不 await 拉取。 */
  readonly catalog: ModelCatalog;
  readonly newId?: () => string;
  /** 注入以便测试断言确切的冷却与 TTL 边界。 */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
  /** 统计写入；不传则不记。实现不得抛异常，见 `StatsStore`。 */
  readonly stats?: StatsSink;
};

/**
 * 转发路径需要的统计写入面。用窄接口而不依赖 `StatsStore`：
 * routes 不该认识 SQLite，测试也能塞记录调用的假实现。
 */
export type StatsSink = {
  recordAttempt(row: {
    requestId: string;
    attemptIndex: number;
    workerId: string;
    protocol: string;
    model: string | null;
    status: number | null;
    failureKind: string | null;
    latencyMs: number | null;
    at: number;
  }): void;
  recordUsage(row: {
    model: string;
    workerId: string;
    at: number;
    usage: TokenUsage | null;
    /** 我们自己没解析完整（而不是上游没报）。见 `StatsStore.UsageRow`。 */
    dropped?: boolean;
    /** 客户端会话摘要；带会话的用量每段会话只保留一条。见 `StatsStore.UsageRow`。 */
    sessionHash?: string | null;
  }): void;
  /** 网关自己拒掉一次请求（从未到达上游）。 */
  recordRejection(row: {
    reason: RejectionReason;
    protocol: string;
    model: string | null;
    at: number;
  }): void;
};

/** 客户端请求体上限。转发面对多模态保持宽松,但不能无界。 */
const MAX_RELAY_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_RESPONSE_ID_BYTES = 128 * 1024;

/**
 * 非流式体超出扫描预算时，只认顶层第一个成员是 `"id"` 的形态。
 * 不另写 JSON 解析器（纪律 #5），字符串字面量仍交给 `JSON.parse` 解码。
 */
const LEADING_ID = /^\s*\{\s*"id"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\.)*")/;

export function createResponseIdCollector(parse: (payload: unknown) => string | null) {
  /** 当前未结束的行。超过预算时整行丢弃(`dropping`),直到下一个换行。 */
  let pending = "";
  let dropping = false;
  /** 非流式体的前缀,最多 `MAX_RESPONSE_ID_BYTES`;`truncated` 表示后面还有。 */
  let buffered = "";
  let truncated = false;
  let id: string | null = null;
  let sawEvent = false;

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    sawEvent = true;
    const data = trimmed.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") return;
    try {
      id = parse(JSON.parse(data)) ?? id;
    } catch {
      /* 畸形事件不影响透传，后续 completed 事件仍可提供 id。 */
    }
  };

  return {
    feed(text: string): void {
      if (!sawEvent && !truncated) {
        const room = MAX_RESPONSE_ID_BYTES - buffered.length;
        if (text.length <= room) {
          buffered += text;
        } else {
          buffered += text.slice(0, room);
          truncated = true;
        }
      }
      // 预算按行计：超长 delta 行只丢它自己，其后带 id 的 completed 行照常解析。
      let start = 0;
      for (;;) {
        const at = text.indexOf("\n", start);
        if (at === -1) break;
        const piece = text.slice(start, at);
        if (!dropping && pending.length + piece.length <= MAX_RESPONSE_ID_BYTES) consume(pending + piece);
        pending = "";
        dropping = false;
        start = at + 1;
      }
      const tail = text.slice(start);
      if (dropping) return;
      if (pending.length + tail.length <= MAX_RESPONSE_ID_BYTES) {
        pending += tail;
      } else {
        pending = "";
        dropping = true;
      }
    },
    value(): string | null {
      if (pending !== "" && !dropping) consume(pending);
      if (id !== null || sawEvent || buffered === "") return id;
      try {
        if (!truncated) return parse(JSON.parse(buffered));
        const leading = LEADING_ID.exec(buffered);
        return leading === null ? null : parse({ id: JSON.parse(leading[1]!) as unknown });
      } catch {
        return null;
      }
    },
  };
}

export function createRelayRoutes(deps: RelayDeps): Hono {
  const app = new Hono();

  // 路由从注册表动态挂载，不写路径字面量（纪律 #4）。
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

async function handleRelay(
  c: Context,
  surface: ProtocolSurface,
  deps: RelayDeps,
): Promise<Response> {
  const config = deps.configOf();

  // 每个动作各自取它实际发生的时刻，见下文 `planNow`。
  const nowOf = (): number => deps.clock?.() ?? Date.now();

  /*
   * 网关拒绝记账。刻意不写进 `upstream_attempts`：那张表只记真实上游尝试。
   * `model` 可为 null，由 `normalizeRejectionModel` 收口并限制客户端字符串进主键。
   */
  const reject = (reason: RejectionReason, model: string | null): void => {
    deps.stats?.recordRejection({ reason, protocol: surface.id, model, at: nowOf() });
  };

  /* ---- 1. 读原始字节(只读一次) ---- */
  let raw: Uint8Array;
  try {
    // 有界读取：`arrayBuffer()` 后再量长度时整个体已进内存。见 `boundedBody.ts`。
    raw = await readBoundedBody(c.req.raw, MAX_RELAY_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      reject("body_too_large", null);
      return c.json(gatewayError("invalid_request", "请求体超过上限"), 413);
    }
    deps.log?.(`读取请求体失败: ${safeErrorMessage(err)}`);
    reject("body_unreadable", null);
    return c.json(gatewayError("invalid_request", "无法读取请求体"), 400);
  }

  if (raw.byteLength === 0) {
    reject("body_empty", null);
    return c.json(gatewayError("invalid_request", "请求体为空"), 400);
  }

  /* ---- 2. 解析副本用于判定(绝不用它重建转发体) ---- */
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // 不回显原始体:它可能很大,也可能含用户的对话内容。
    reject("body_not_json", null);
    return c.json(gatewayError("invalid_request", "请求体不是合法 JSON"), 400);
  }

  const model = surface.extractModel(parsed);
  if (model === null) {
    reject("model_missing", null);
    return c.json(
      gatewayError("invalid_request", "请求体缺少合法的 model 字段"),
      400,
    );
  }
  // 客户端可控，进日志、错误消息与统计前统一脱敏截断。
  const displayModel = redactText(model, 128);

  /* ---- 3. 免费判定(在请求出去之前) ---- */

  /*
   * 目录交集只读缓存，绝不发请求：目录由启动预热与 `/v1/models` 维护，
   * 在转发路径上刷新会把每个请求变成两次上游调用，且拉取失败时不收敛。
   *
   * 读槽与下面 `retired` 分支的写槽都由同一个 `catalogIdentity` 决定（纪律 #4）：
   * 此时尚未选 Worker，硬写 keyed 会在全员缺 key 时让刷新写进另一个槽。
   * 一个槽位的目录用于所有 Worker，依据是免费子集跨账号一致（见 `catalog.ts`）。
   * 拿不到目录时退回只看后缀与名单，见 `judgeFree`。
   */
  const catalogIdentity = catalogIdentityOf(config);
  const verdict = judgeFree(model, config.models, deps.catalog.cached(slotOf(catalogIdentity)));
  if (!verdict.free) {
    /*
     * 消息带上模型 id（客户端自己发的公开标识），否则无法自查。
     * `retired`：免费依据成立但已不在在架目录，单独措辞以指向 extraFreeIds。
     */
    if (verdict.reason === "retired") {
      /*
       * 转发路径上唯一刷目录的地方，只在过期时刷：旧目录唯一的实际伤害是
       * 误拒新上架的模型。刷新成功后即新鲜，失败有退避（见 catalog.ts）。
       */
      deps.catalog.refreshIfStale(catalogIdentity, config, deps.upstreamOf);
    }
    const message =
      verdict.reason === "retired"
        ? `模型 ${displayModel} 已不在上游在架目录中(它符合免费约定,但上游已下架)。可刷新 /v1/models 确认,并从配置的 models.extraFreeIds 中移除`
        : `模型 ${displayModel} 不在免费集内。本网关只放行免费模型;可在配置的 models.extraFreeIds 中调整`;
    // `not_free` 与 `retired` 分开计数：前者改模型名，后者删 extraFreeIds 条目。
    reject(verdict.reason === "retired" ? "retired" : "not_free", model);
    return c.json(gatewayError("model_not_allowed", message), 403);
  }

  /*
   * 放行但未经在架核验时用诊断头报出（离线时每个请求都会是，日志会刷屏）。
   * 用于区分「目录说在架但上游拒了」与「压根没拿到目录」。
   */
  const freeHeaders =
    verdict.reason === "suffix_unverified" || verdict.reason === "extra_unverified"
      ? { "x-zen-gateway-free": `${verdict.reason}` }
      : {};

  /* ---- 4. 流式能力校验(在选 Worker 之前:这是请求本身的问题) ---- */
  const streaming = surface.wantsStream(parsed);

  /*
   * 执行面声明的流式能力：`"none"` 面收到流式请求 → 400，否则会挂住或拿到无法解析的响应。
   * `"sse"` 面收到非流式请求不拦：Messages 这类面两者都支持。
   */
  if (surface.streaming === "none" && streaming) {
    reject("stream_unsupported", model);
    return c.json(
      gatewayError(
        "invalid_request",
        `协议面 ${surface.id} 不支持流式,请去掉 stream: true`,
      ),
      400,
    );
  }

  const clientHeaders = c.req.header();

  /*
   * 时钟不共用：一次尝试可耗时数分钟，冷却若从请求开始起算，到期时刻早已过去
   * （body 空闲超时的 Worker 将永不进入冷却）。每个动作用它实际发生的时刻：
   * 选 Worker 与落绑定用 `planNow`；冷却在每次尝试失败时；改绑在链结束时；
   * 指纹学习在流结束时。
   */
  const planNow = nowOf();

  /* ---- 5. 选 Worker(调度状态机) ---- */

  /*
   * 亲和依据：体内会话指针优先，其次是客户端发来的 `x-opencode-session`。
   * 只读客户端原始头：`headers.ts` 合成的值每请求不同，对亲和无用。
   */
  const sessionHash = sessionHashFrom({
    bodyKey: surface.sessionKeyFrom(parsed),
    headerValue: clientHeaders["x-opencode-session"],
  });
  const blobHashes = extractBlobHashes(parsed);
  /*
   * 用量按会话去重只认客户端的 `x-opencode-session` 头：Responses 面的 `previous_response_id`
   * 每轮都变，用它会让同一段对话每轮都算新会话。
   */
  const usageSession = sessionHashFrom({ bodyKey: undefined, headerValue: clientHeaders["x-opencode-session"] });

  const plan = deps.scheduler.plan({ config, now: planNow, sessionHash, blobHashes });
  const targets: readonly AttemptTarget[] = plan.targets;
  if (targets.length === 0) {
    // 全池冷却或全员不可用；route 头只有发起方看得到，计数才能事后查。
    reject("no_worker", model);
    return c.json(
      gatewayError("no_worker_available", describeNoWorker(config)),
      503,
    );
  }

  /* ---- 6. 重试链 ---- */

  // 一条客户端请求一个 requestId，其所有尝试共用：请求数 ≠ 尝试数。
  const requestId = (deps.newId ?? randomUUID)();
  let attemptIndex = 0;

  let result;
  try {
    result = await runRetryChain({
      targets,
      maxAttempts: config.gateway.maxAttempts,
      url: upstreamUrl(config.gateway.baseUrl, surface.upstreamPath),
      method: "POST",
      body: raw,
      signal: c.req.raw.signal,
      deps: deps.upstreamOf(config),
      // 只有做了目录交集且命中的判定才算核验过;关掉交集或缺目录时 401 可能只是模型名问题。
      modelVerified:
        config.models.enforceCatalog &&
        verdict.reason !== "suffix_unverified" &&
        verdict.reason !== "extra_unverified",
      // 传下注入的时钟，否则 `latencyMs` 恒用 `Date.now()`，测试无法固定。
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      // 逐次记账：链中每次尝试都是独立事实；`nowOf()` 现取即失败时刻。
      onAttempt: (record) => {
        const at = nowOf();
        deps.scheduler.record(record, config, at);
        /*
         * 调度记账（影响冷却）排在统计（诊断）之前，不依赖 sink 不抛的承诺。
         * `attemptIndex` 用自增闭包，与 `result.attempts` 下标一致。
         */
        deps.stats?.recordAttempt({
          requestId,
          attemptIndex: attemptIndex++,
          workerId: record.workerId,
          protocol: surface.id,
          // model 是客户端可控字符串 —— 进库也要限长,理由同进日志。
          model: displayModel,
          status: record.status,
          failureKind: record.failure,
          latencyMs: record.latencyMs,
          at,
        });
      },
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
    // 客户端已断开：不是网关故障，不记转发失败、不造 500；已发生的尝试已记账。
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    // buildHeaders 抛的 HeaderValidationError 会走到这里 —— 那是 400。
    const mapped = errorBodyFromException(err);
    deps.log?.(`转发失败: ${safeErrorMessage(err)}`);
    return c.json(mapped.body, mapped.status as 400 | 500);
  }

  /* ---- 7. 透传 ---- */

  /*
   * 透传兜底：上游已成功，此处抛出会给客户端裸 500 且不留日志。
   * body 由锁住它的 `pipe.ts` 在失败路径释放（`releaseOnFailure`），这里只负责日志与错误形状。
   */
  const pipeOrFail = (
    upstream: NonNullable<typeof result.response>,
    extra: Record<string, string>,
    /** 承接者;失败路径为 null —— 见 `Scheduler.settleStream` 的说明。 */
    workerId: string | null,
  ): Response => {
    /*
     * 不变量 #3 的结算钩子。扫描器跨块工作：拒绝消息可能被切在两个 SSE 块之间。
     * 回调只在流结束后更新亲和，不做重试决定（不变量 #1）。
     */
    const scanner = createOverlapScanner(STALE_PATTERN_WINDOW, containsStaleReasoning);
    const responseIds = createResponseIdCollector(surface.responseIdFrom ?? (() => null));
    // `ProtocolSurface.parseUsage` 的唯一生产调用点；结果写日志并入库。
    const usage = createUsageCollector((payload) => surface.parseUsage(payload));
    try {
      return pipeUpstreamResponse(upstream, extra, {
        onText: (text) => {
          scanner.feed(text);
          usage.feed(text);
          responseIds.feed(text);
        },
        onDone: (error) => {
          /*
           * 结算先于日志，顺序承重：`tap.ts` 吞掉 onDone 的异常，其后语句静默跳过。
           * 规则：onDone 里不变量相关的动作排在诊断动作之前。
           */
          deps.scheduler.settleStream({
            workerId,
            sessionHash,
            blobHashes,
            status: upstream.status,
            staleHit: scanner.hit(),
            // 上游中断或下游取消 → 内容不完整,既不学习也不遗忘。
            complete: error === null,
            // 流结束的时刻 —— 指纹的 TTL 从签发完成起算。见 nowOf 的说明。
            now: nowOf(),
          });

          const outputId = responseIds.value();
          if (
            outputId !== null &&
            error === null &&
            !scanner.hit() &&
            workerId !== null &&
            upstream.status >= 200 &&
            upstream.status < 300
          ) {
            deps.scheduler.rebind(digestOf(outputId), workerId, nowOf());
          }

          /*
           * 用量日志：只在拿到用量时打。model 是客户端可控字符串，
           * 必须过 `redactText` 防日志行注入与无界放大（纪律 #4：净化只有一处定义）。
           */
          const totals = usage.usage();
          const label = `${surface.id}/${displayModel}`;
          if (totals !== null) {
            deps.log?.(`用量 ${label}: ${describeUsage(totals)}`);
          }
          // 我们自己丢了内容要如实报出，不能看起来像「上游没报用量」。
          if (usage.dropped()) {
            deps.log?.(`用量 ${label}: 响应过大,本次未能完整解析用量(不影响转发)`);
          }

          /*
           * 用量入库：`totals === null` 也要记，否则覆盖率分母漏掉这次请求。
           * `workerId` 为 null 是失败路径，没有承接者，不记。
           */
          if (workerId !== null) {
            deps.stats?.recordUsage({
              // 与日志同一份限长处理 —— 两处都不能让客户端字符串无界进去。
              model: displayModel,
              workerId,
              at: nowOf(),
              usage: totals,
              // 我们自己丢了（界定常量或上游断流）与「上游没报」分开记。
              dropped: usage.dropped(),
              sessionHash: usageSession,
            });
          }
        },
      });
    } catch (err) {
      // 兜底释放只对 pipe 锁流之前就抛的路径有效；已被 tap 锁住时由 pipe.ts 释放。
      void upstream.body?.cancel().catch(() => {});
      deps.log?.(`响应透传失败(上游已成功): ${safeErrorMessage(err)}`);
      return c.json(
        gatewayError("internal_error", "网关无法转发上游响应,详见服务端日志"),
        500,
      );
    }
  };

  if (result.ok) {
    /*
     * 会话改绑到实际承接者：重试链可能越过首位，推理块由后者签发。
     * 在链 settled 时改绑而非流末尾：客户端提前断开时 settleStream 不触发。
     */
    deps.scheduler.rebind(sessionHash, result.workerId, nowOf());

    return pipeOrFail(
      result.response,
      {
        // 诊断头:这次由哪个 Worker 承接。便于用户核对出口隔离是否按预期生效。
        "x-zen-gateway-worker": result.workerId,
        // 为什么是它 —— 粘滞/指纹提示/策略/全员冷却。排查"为什么换了 Worker"用。
        "x-zen-gateway-route": plan.reason,
        // 诊断头在成功与失败路径都给；成功前的重试次数同样是该被看见的信号。
        "x-zen-gateway-attempts": String(result.attempts.length),
        ...freeHeaders,
      },
      result.workerId,
    );
  }

  /*
   * 失败但拿到了上游响应：原样透传真实错误负载。
   * 这条路径也要结算（回放他人推理块的拒绝正是 400）；非 2xx 只解绑不学习，workerId 传 null。
   * 诊断头在失败时更需要；worker 取最后一次尝试。
   */
  if (result.response !== null) {
    const lastWorkerId = result.attempts.at(-1)?.workerId;
    return pipeOrFail(
      result.response,
      {
        "x-zen-gateway-attempts": String(result.attempts.length),
        "x-zen-gateway-route": plan.reason,
        ...(lastWorkerId !== undefined ? { "x-zen-gateway-worker": lastWorkerId } : {}),
        ...freeHeaders,
      },
      null,
    );
  }

  /*
   * 连响应头都没拿到：网关自造错误。出口配置失败报 `egress_unavailable`（503），
   * 不跟 400：那是本机配置问题，且客户端不会重试 4xx。
   */
  const type = result.egressSetup ? "egress_unavailable" : typeForFailureKind(result.kind);
  deps.log?.(`转发失败(${result.egressSetup ? "出口配置" : result.kind}): ${result.reason}`);
  return c.json(
    gatewayError(type, `上游请求失败:${result.reason}`),
    statusForGatewayError(type) as 400 | 500 | 502 | 503,
  );
}
