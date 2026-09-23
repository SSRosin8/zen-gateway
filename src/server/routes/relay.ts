import { Hono, type Context } from "hono";
import type { Config } from "../../shared/schema.ts";
import type { ProtocolRegistry } from "../../core/protocols/registry.ts";
import type { ProtocolSurface } from "../../core/protocols/types.ts";
import { judgeFree } from "../../core/models/free.ts";
import { ModelCatalog, catalogIdentityOf } from "../../core/models/catalog.ts";
import { createUsageCollector, describeUsage } from "../../core/models/usage.ts";
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
  extractBlobHashes,
  STALE_PATTERN_WINDOW,
} from "../../core/routing/affinity.ts";
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
 *   4. 流式能力校验(面声明 `streaming: "none"` 时拒绝流式请求)
 *   5. 选 Worker
 *   6. 重试链(只看 status+headers,body 不消费)
 *   7. 流式透传(唯一写字节的地方)
 *
 * 第 1 与第 2 步分开是「原样透传」的要求:转发出去的必须是客户端发来的原始
 * 字节。实测 `JSON.parse` → `stringify` 往返**不是无损的**
 * (`{"n":1.0}` → `{"n":1}`),而这个网关的存在意义就是让 OpenCode 像直连
 * 上游一样工作 —— 我们不该引入任何客户端察觉得到的差异。
 *
 * 第 3、4 步都必须在第 6 步之前:它们判定的都是**请求本身**的问题,
 * 在本机就能定论,不该花一次上游调用去换一个我们已经知道的答案。
 * 第 3 步尤其如此 —— 放行一个付费模型的代价是真金白银,一旦发出去无法收回。
 */

export type RelayDeps = {
  /** 读当前配置。做成函数以便配置热更新后立即生效。 */
  readonly configOf: () => Config;
  readonly registry: ProtocolRegistry;
  /** 上游依赖(dispatcher 池、锁、Controller)。 */
  readonly upstreamOf: (config: Config) => UpstreamDeps;
  /**
   * 调度器。**进程内唯一** —— 两个调度器意味着两份冷却状态,
   * 于是「这个 Worker 在冷却」取决于请求碰巧走到哪一份。
   */
  readonly scheduler: Scheduler;
  /**
   * 在架目录缓存。与 `/v1/models` **共用同一个** —— 见 `app.ts`。
   *
   * 转发路径只读已缓存的那份,**绝不 await 一次目录拉取**:那会给每个转发
   * 请求加上第二个网络依赖,而目录只是个放行判定的辅助。
   */
  readonly catalog: ModelCatalog;
  /** 注入以便测试。 */
  readonly newId?: () => string;
  /** 注入以便测试断言确切的冷却与 TTL 边界。 */
  readonly clock?: () => number;
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

  /*
   * 目录交集用 `"keyed"` 槽位,而且**只读缓存,绝不发请求**。
   *
   * 槽位是确定的:转发候选链里每个 Worker 都有 key(`isUsable` 只看 key),
   * 所以这条路径的身份恒为「带 key」。
   *
   * ## 一个槽位的目录用于**所有** Worker,依据是免费子集一致
   *
   * 本阶段实测(三个付费账号,三轮稳定):整份目录**按账号不同**
   * (两个账号 41 个模型、一个 79 个),但**免费子集三个账号完全一致**
   * (各 9 个,逐 id 相同)。交集要的恰好是那个一致的子集,所以这里不需要
   * 知道最终路由到哪个 Worker(那在第 5 步才定)。
   *
   * 我先前在这里写的是"目录按带 key／免 key 区分,不按账号个体" ——
   * **那句是错的**,第三个账号就推翻了它。详见 `catalog.ts` 文件头记的
   * 三次修正。现在这条注释只声称被测量支持的那个更弱的性质。
   *
   * 若免费子集哪天也按账号分化,两侧后果不对称:缓存里**多**一个 →
   * 上游 400 `bad_request`,不重试不归咎,自限;缓存里**少**一个 →
   * 误拒可用模型,所以下面 `retired` 那支会触发一次刷新。
   *
   * ## 为什么转发路径不在这里刷目录
   *
   * 我第一版在每个转发请求上调 `refreshIfStale`,想让"繁忙的网关自然保持
   * 目录新鲜"。那是**错的耦合**,而集成测试立刻查出来了:一次客户端请求
   * 变成两次上游请求(POST 转发 + GET 目录)。更糟的是它不收敛 ——
   * 拉取失败不填缓存,于是下个请求发现仍然过期又发一次,稳态下永久 ×2,
   * 而这个放大恰好发生在上游已经不稳的时候。
   *
   * 目录该由**它自己的**路径维护:启动预热 + `/v1/models` 被访问时。
   * OpenCode 本来就会拉模型列表,所以那条路径有真实流量。
   *
   * 拿不到目录时退回"只看后缀与名单"(见 `judgeFree` 里"目录缺失时放行"
   * 那节 —— 拒绝的代价是全面不可用,而放行的代价只是由上游拒绝,不产生费用)。
   */
  const verdict = judgeFree(model, config.models, deps.catalog.cached("keyed"));
  if (!verdict.free) {
    /*
     * 消息里带上模型 id。
     *
     * 这与「校验消息不回显用户数据」不冲突:模型 id 是客户端自己刚发来的、
     * 且是公开目录里的标识,不是凭证也不是他人数据。而没有它这条错误就无法自查
     * —— 用户看到「模型不允许」却不知道是哪个模型被拒。
     *
     * 两种拒绝分开措辞。`retired` 是 Phase 6 才有的新结局:模型的**免费依据
     * 成立**(后缀或名单命中)但它**已不在上游在架目录**里。先前这类请求会被
     * 放行然后由上游返回 400 `Model is unavailable.`,用户看到的是上游措辞,
     * 完全指不到"这个 id 已经下架了,把它从 extraFreeIds 里删掉"。
     */
    if (verdict.reason === "retired") {
      /*
       * **唯一**在转发路径上刷目录的地方,而且只在过期时刷一次。
       *
       * 理由很窄:一份过期目录唯一能造成的实际伤害就是这一个 ——
       * 上游**新上架**了这个模型而我们手里的旧目录里没有,于是拒掉一个
       * 本可用的请求。其余情形下旧目录只是"可能多放行一个已下架的",
       * 而那由上游拒绝,代价可见且不花钱。
       *
       * 不怕被刷:刷成功后目录就是新鲜的,同一个模型的后续请求不会再触发
       * (`isFresh` 为真);刷失败则有失败退避压着。两条都在 catalog.ts 里。
       */
      deps.catalog.refreshIfStale(catalogIdentityOf(config), config, deps.upstreamOf);
    }
    const message =
      verdict.reason === "retired"
        ? `模型 ${model} 已不在上游在架目录中(它符合免费约定,但上游已下架)。可刷新 /v1/models 确认,并从配置的 models.extraFreeIds 中移除`
        : `模型 ${model} 不在免费集内。本网关只放行免费模型;可在配置的 models.extraFreeIds 中调整`;
    return c.json(gatewayError("model_not_allowed", message), 403);
  }

  /* ---- 4. 流式能力校验(在选 Worker 之前:这是请求本身的问题) ---- */
  const streaming = surface.wantsStream(parsed);

  /*
   * 面声明的流式能力必须真的被执行,否则 `streaming` 只是一个注释。
   *
   * 这条先前不存在:`ProtocolSurface.streaming` 被声明、被文档说明「`"none"`
   * 为 jev 这类非流式面预留」,但全仓没有任何一处读它 —— 把 `chatSurface`
   * 的 `"optional"` 改成 `"none"` 后 859 条测试全绿。那是一个**声明了却不设防
   * 的能力位**:Phase 6 若按规划新增一个 `streaming: "none"` 的面,客户端发
   * `stream: true` 会被照常加上 `Accept: text/event-stream` 并走流式泵,
   * 而上游那个面根本不产生 SSE —— 症状是挂住或拿到一段解析不了的响应。
   *
   * 只拦不含歧义的那个方向:`"none"` 面收到流式请求 → 400。
   * `"sse"` 面收到非流式请求**不拦** —— Anthropic Messages 这类面两者都支持,
   * 把「只声明了 sse」当成「必须流式」会拦掉合法请求。
   */
  if (surface.streaming === "none" && streaming) {
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
   * 时钟取值点:**每个需要时刻的动作各自取一次**,不共用一个。
   *
   * 先前这里只取一次 `now` 并让整条链共用,而第五轮审核实测出后果:
   * 一次尝试可以耗 60-300 秒(headers/body 超时),于是冷却从**请求开始**
   * 时刻起算,算出来的到期时刻早已成为过去。
   *
   * ```
   * 请求耗时 2515ms (headersTimeout=2000, 名义冷却=1000ms)
   * 失败后立刻查: ready=true 剩余冷却=0ms lastFailure=timeout
   * ```
   *
   * 更糟的是算术推论:`bodyTimeoutMs` 默认 300000 > `transportMaxMs` 上限
   * 120000,所以 **body 空闲超时的 Worker 永远不会进入冷却**,失败多少次都不会。
   * 而 `timeout` 恰好是「上游卡住」这种最需要把 Worker 踢出候选的故障。
   *
   * 三个动作各有正确的时刻,它们本来就该分开。规则很简单:
   * **每个动作用它实际发生的那一刻**。
   *
   * | 动作 | 时刻 | 为什么 |
   * |---|---|---|
   * | 选 Worker + 落会话绑定 | `planNow` | 同一次请求内的判定要一致 |
   * | 冷却记账 | 每次尝试**失败时** | 冷却是「从现在起别再打它」 |
   * | 改绑实际承接者 | 链**结束时** | 那一刻才知道是谁承接的 |
   * | 指纹学习 | 流**结束时** | TTL 滑动、度量闲置,而签发到流结束才完成 |
   *
   * 我原先写在 `scheduler.ts` 的注释说「亲和绑定与冷却必须看同一个 now」——
   * 那句只对第一行成立,被我错误地推广到了整条链。
   */
  const nowOf = (): number => deps.clock?.() ?? Date.now();
  const planNow = nowOf();

  /* ---- 5. 选 Worker(调度状态机) ---- */

  /*
   * 亲和的两条依据。
   *
   * `sessionHashFrom` 优先用体内的会话指针(Responses 面的
   * `previous_response_id`),没有才用 `x-opencode-session` 头。
   *
   * 注意这里读的是**客户端发来的**头:`headers.ts` 在客户端没发时会合成一个,
   * 但那个每请求都不同,对亲和没有帮助 —— 那种情况下粘滞自然失效,
   * 而这是正确的(我们确实无法判断这是不是同一条会话)。
   */
  const sessionHash = sessionHashFrom({
    bodyKey: surface.sessionKeyFrom(parsed),
    headerValue: clientHeaders["x-opencode-session"],
  });
  const blobHashes = extractBlobHashes(parsed);

  const plan = deps.scheduler.plan({ config, now: planNow, sessionHash, blobHashes });
  const targets: readonly AttemptTarget[] = plan.targets;
  if (targets.length === 0) {
    return c.json(
      gatewayError("no_worker_available", describeNoWorker(config)),
      503,
    );
  }

  /* ---- 6. 重试链 ---- */
  let result;
  try {
    result = await runRetryChain({
      targets,
      maxAttempts: config.gateway.maxAttempts,
      url: upstreamUrl(config.gateway.baseUrl, surface.upstreamPath),
      method: "POST",
      body: raw,
      deps: deps.upstreamOf(config),
      /*
       * 冷却记账。逐次回调,而不是等链结束一次性记 ——
       * 链中每一次尝试都是一个独立的事实:`w1 限流 → w2 传输失败 → w3 成功`
       * 这条链里三个 Worker 的处置完全不同,只记最后一个会让前两个的故障
       * 消失,于是下一条请求又把它们重试一遍。
       *
       * `nowOf()` 在回调里**现取**,不用 `planNow`:这个回调在该次尝试
       * 结束时同步触发,所以此刻就是失败发生的时刻。见上面 `nowOf` 的说明。
       */
      onAttempt: (record) => deps.scheduler.record(record, config, nowOf()),
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

  /* ---- 7. 透传 ---- */

  /*
   * 透传包一层兜底。
   *
   * `pipeUpstreamResponse` 对畸形头与畸形 statusText 都已容错,理论上不抛;
   * 但这里是**上游已经成功之后**的位置,一旦抛异常后果特别糟:客户端拿到裸 500
   * (不是我们的 JSON 错误形状)、上游那次请求已真实计入额度、
   * 而且 `deps.log` 完全不被调用 —— 异常绕过所有日志路径,故障现场什么都不留。
   *
   * ## body 的释放责任在 pipe,不在这里
   *
   * 这一点先前写错了。原注释承诺"这层兜底保证**无论如何 body 都被处置**",
   * 而第五轮审核指出:加了 tap 之后那个承诺**结构上不可能成立** ——
   * `tapReadable` 内部 `getReader()` 锁住了流,于是这里的
   * `upstream.body?.cancel()` 会异步拒绝 `Invalid state: ReadableStream is
   * locked`,并被 `.catch()` 静默吞掉。实测后果:连接泄漏到 `bodyTimeout`
   * (5 分钟)、`onDone` 一次都不触发(不变量 #3 整条漏掉)。
   *
   * 现在 `pipe.ts` 在自己的失败路径上释放它锁住的流(见那里的
   * `releaseOnFailure`)—— **谁锁的谁负责**。这里只保留日志与错误形状:
   * 那两件事仍然只有这一层能做。
   */
  const pipeOrFail = (
    upstream: NonNullable<typeof result.response>,
    extra: Record<string, string>,
    /** 承接者;失败路径为 null —— 见 `Scheduler.settleStream` 的说明。 */
    workerId: string | null,
  ): Response => {
    /*
     * 不变量 #3 的结算钩子。
     *
     * 扫描器**跨块**工作:要匹配的拒绝消息可能正好被切在两个 SSE 块之间,
     * 逐块独立匹配会漏 —— 而漏掉的症状取决于上游的分块位置,时有时无。
     *
     * 这不违反不变量 #1:这里不做任何重试决定,回调只在流彻底结束之后
     * 更新亲和映射,那时响应早已完整发给客户端。
     */
    const scanner = createOverlapScanner(STALE_PATTERN_WINDOW, containsStaleReasoning);
    /*
     * 用量收集 —— `ProtocolSurface.parseUsage` 的**生产调用点**。
     *
     * 这一条刻意与面一同落地,而不是等到 Phase 7 需要它时再接。第四轮审核的
     * `streaming` 字段就是反面教材:它被声明、被文档说明、却**全仓没有一处读它**,
     * 把 `chatSurface` 的 `"optional"` 改成 `"none"` 后 859 条测试全绿 ——
     * 一个声明了却不设防的能力位。`parseUsage` 若只有接口与实现而没有调用点,
     * 就是同一个形态:三个面各写一份解析,而它们是否接对了没有任何东西会发现。
     *
     * 现在它有了唯一真实读者,于是"面接错了信封"会在集成测试里表现出来。
     *
     * 眼下的消费方式只有日志(Phase 7 才把它写进 `runtime.db` 做聚合)——
     * 但这是**真的调用**,不是占位:接错面、改坏字段归一化、把跨事件合并
     * 去掉,都会让日志里的数字变错并被测试抓住。
     */
    const usage = createUsageCollector((payload) => surface.parseUsage(payload));
    try {
      return pipeUpstreamResponse(upstream, extra, {
        onText: (text) => {
          scanner.feed(text);
          usage.feed(text);
        },
        onDone: (error) => {
          /*
           * 用量日志。
           *
           * 只在拿到用量时打 —— 免费模型的响应**未必**带 usage,
           * 而每个请求打一行"用量: 无"只会淹没日志。
           *
           * `describeUsage` 只输出数字,不含任何响应内容。
           */
          const totals = usage.usage();
          if (totals !== null) {
            deps.log?.(`用量 ${surface.id}/${model}: ${describeUsage(totals)}`);
          }

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
        },
      });
    } catch (err) {
      /*
       * 兜底释放 —— 只对**未被 tap 包装**的 body 有效。
       *
       * 传了 tap 时流已被 `tapReadable` 锁住,这句会异步拒绝并被吞掉;
       * 那种情况由 `pipe.ts` 自己释放(见上面的说明)。保留这句是为了覆盖
       * 「pipe 在锁流**之前**就抛」的路径(例如将来某处在构造 Headers 时抛),
       * 那时 body 还没被锁,而这里是唯一能释放它的地方。
       */
      void upstream.body?.cancel().catch(() => {});
      deps.log?.(`响应透传失败(上游已成功): ${logMessageFor(err)}`);
      return c.json(
        gatewayError("internal_error", "网关无法转发上游响应,详见服务端日志"),
        500,
      );
    }
  };

  if (result.ok) {
    /*
     * 会话改绑到**实际**承接的 Worker。
     *
     * `plan` 绑的是候选链首位,而重试链可能往后走:一条
     * 「w1 拿到 429 → w2 成功」的链里签发推理块的是 w2。不改绑的话,
     * 等 w1 冷却结束下一轮就回到它,而客户端回放的是 w2 签发的推理块 ——
     * 上游必拒。症状是「对话隔一会儿报一次错」,且只在限流之后出现。
     *
     * 放在这里而不是流末尾的结算里:会话身份在链 settled 的这一刻就已确定,
     * 而 `settleStream` 只在客户端**真的读完响应**时触发 —— 放那里的话
     * 一次提前断开就会让绑定停在错误的 Worker 上。
     */
    deps.scheduler.rebind(sessionHash, result.workerId, nowOf());

    return pipeOrFail(
      result.response,
      {
        // 诊断头:这次由哪个 Worker 承接。便于用户核对出口隔离是否按预期生效。
        "x-zen-gateway-worker": result.workerId,
        // 为什么是它 —— 粘滞/指纹提示/策略/全员冷却。排查"为什么换了 Worker"用。
        "x-zen-gateway-route": plan.reason,
      },
      result.workerId,
    );
  }

  /*
   * 失败但**拿到了上游响应** —— 原样透传。
   *
   * 客户端应当看到上游真实的错误负载(429 的 retry-after 说明、
   * 400 的字段级报错),而不是网关的转述。这也是唯一能让用户看到
   * 上游真实拒绝原因(例如 FreeTierError)的路径。
   *
   * 这条路径**也要结算**:上游对"回放了别人的推理块"的拒绝正是一个 400,
   * 而不结算会让下一轮回到同一个必败 Worker。状态码非 2xx,所以只会
   * 解绑与遗忘,不会学习 —— 因此 workerId 传 null(见 `settleStream` 的说明)。
   *
   * ## 诊断头在失败时**更**需要,先前这里漏了
   *
   * 第五轮审核查出:`x-zen-gateway-route` 只在成功路径设置,而我写的文档
   * 却教用户"全员冷却时看 route 头" —— 那两个条件不可能同时成立
   * (全员冷却且上游失败时走的正是这条路径)。缺口 #8 还把这个头当作
   * 「当前唯一的调度状态观察手段」,于是用户在最需要它的时候拿不到。
   *
   * `worker` 头也补上:失败时"是哪个账号失败的"是首要问题。取最后一次
   * 尝试的 Worker —— 那是产出这个响应的那个。
   */
  if (result.response !== null) {
    const lastWorkerId = result.attempts.at(-1)?.workerId;
    return pipeOrFail(
      result.response,
      {
        "x-zen-gateway-attempts": String(result.attempts.length),
        "x-zen-gateway-route": plan.reason,
        ...(lastWorkerId !== undefined ? { "x-zen-gateway-worker": lastWorkerId } : {}),
      },
      null,
    );
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
