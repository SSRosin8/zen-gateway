import type { Response as UndiciResponse } from "undici";
import { tapReadable, type StreamTap } from "./tap.ts";

/**
 * 流式透传 —— **唯一**写出客户端响应字节的地方。
 *
 * ## 不变量 #1 的另一半
 *
 * `retry.ts` 只判重试、绝不写字节;本文件只写字节、绝不判重试。两者在目录层面
 * 分开,是为了让「发过字节后又重试」这个错误**写不出来** —— 想犯它得先把
 * 两个模块合并,而那是一次显眼的改动,不是一行不小心的顺手改。
 *
 * 因此本文件里没有任何 `if (失败) 换 Worker` 的分支,也不该加。
 *
 * ## 原样透传:body 不经反序列化
 *
 * 直接把上游的 `ReadableStream` 交给客户端响应,不 `JSON.parse` 再 `stringify`。
 * 实测那个往返**不是无损的**:`{"n":1.0,"s":"你好"}` 往返后变成
 * `{"n":1,"s":"你好"}` —— 字节数、数字字面量、转义形式全变了。
 * 对一个「让 OpenCode 原样用上游」的网关,这种差异不该由我们引入。
 *
 * 顺带的好处是内存:多模态请求的响应可能很大,流式透传不需要全量缓冲。
 *
 * ## 响应头必须过滤
 *
 * 逐跳头与 `content-length` 不能原样转发:
 * - 逐跳头(`connection`/`transfer-encoding`/…)只对单跳有效,转发会让客户端
 *   与我们对连接状态产生分歧。
 * - `content-encoding`/`content-length`:undici 的 fetch **已经替我们解压**了
 *   响应体。把上游的 `content-encoding: gzip` 原样转发,客户端会拿着已解压的
 *   字节再去 gunzip,得到解码失败;`content-length` 同理对不上解压后的长度。
 *   这是转发型网关最常见的一个 bug,而它只在上游启用压缩时才出现。
 */

/** 不得转发给客户端的响应头(小写)。 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  // 逐跳头。
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-connection",
  /*
   * undici 的 fetch 已解压响应体,这两个头描述的是**压缩前**的形态。
   * 转发它们会让客户端对已解压的字节再解一次。
   */
  "content-encoding",
  "content-length",
]);

/**
 * 把上游响应转成给客户端的响应,body 原样流式透传。
 *
 * `extraHeaders` 用于加网关自己的诊断头(例如命中了哪个 Worker)。
 * 它在过滤之后写入,因此不会被上游头覆盖。
 *
 * ## 为什么这里必须对畸形头**容错**而不是抛错
 *
 * 这个函数在**上游已经成功之后**被调用。此时抛异常的后果特别糟:
 * 客户端拿到一个裸 500（不是网关的 JSON 错误形状）,而上游那次请求
 * 已经真实发生并计费/计入额度,响应体流既没转发也没释放。
 *
 * 而 `headers.set()` 确实可能抛 —— 头名/头值都来自**上游**,不在我们控制内。
 * 一个畸形的上游头不该让整个请求变成 500:跳过它、把其余内容照常转发,
 * 远好于丢掉一个本来成功的响应。
 *
 * (`extraHeaders` 是网关自己构造的,其中的 worker id 现已由 `IdSchema`
 * 约束字符集;但这里同样容错 —— 纵深防御,且成本只是一个 try。)
 */
export function pipeUpstreamResponse(
  upstream: UndiciResponse,
  extraHeaders?: Readonly<Record<string, string>>,
  /**
   * 旁路观察(不变量 #3 的挂点)。
   *
   * 字节**不经过**它 —— 见 `tap.ts`:返回的流与入参逐字节相同,时序也不变。
   * 可选参数而不是必填:目录查询与测试都不需要结算,强制它们传一个空实现
   * 只会让"没有结算"和"结算是空的"看起来一样。
   */
  tap?: StreamTap,
): Response {
  const headers = new Headers();

  upstream.headers.forEach((value, name) => {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    try {
      headers.set(name, value);
    } catch {
      /*
       * 上游给了一个 Headers 拒绝的名/值(含 CR/LF 或非法 token 字符)。
       * 跳过这一个头,继续转发其余内容 —— 见函数注释。
       */
    }
  });

  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    try {
      headers.set(name, value);
    } catch {
      // 诊断头加不上不影响转发本身。
    }
  }

  /*
   * body 不读、不拷贝、不反序列化。
   *
   * 传了 `tap` 时经一层旁路中转,但那一层同样不改字节也不改时序
   * (见 `tap.ts`)—— 它只是把解码后的**副本**交给扫描器。
   *
   * 204/304 与 HEAD 的响应没有 body,此时必须传 null ——
   * 给一个「不该有体」的状态码配上流会被 Response 构造函数拒绝。
   */
  const body = upstream.body as ReadableStream<Uint8Array> | null;
  const hasBody = body !== null && upstream.status !== 204 && upstream.status !== 304;

  /*
   * 没有 body 时也要通知结算方一次。
   *
   * 少了这一条,`tap.onDone` 在 204/HEAD 这类响应上**永不触发** ——
   * 而结算方(`Scheduler.settleStream`)是靠它决定"这次到底算不算完成"的,
   * 于是一次本该学习绑定的成功被静默丢掉。症状是粘滞偶发失效,
   * 且只在上游返回无体响应时出现。
   */
  const outBody = hasBody && tap !== undefined ? tapReadable(body, tap) : hasBody ? body : null;
  if (!hasBody && tap !== undefined) {
    try {
      tap.onDone(null);
    } catch {
      /* 结算失败不影响响应本身 */
    }
  }

  /*
   * `statusText` 也来自上游,同样可能畸形。
   *
   * 注意:`@hono/node-server` 的 `serve()` 会把全局 `Response` 换成一个
   * 不校验 statusText 的实现,所以生产路径下这一条通常不触发 —— 但单测里
   * 用的是标准 `Response`(会校验),而且我们不该依赖那个替换行为。
   * 失败时退回不带 statusText 的构造:状态码与 body 才是语义所在。
   *
   * ## 两次构造都失败时,必须由本函数释放它锁住的流
   *
   * 第五轮审核查出的最要紧一条。`tapReadable` 内部 `getReader()` 会**锁住**
   * 上游 body,而 `new Response()` 仍可能抛 —— 状态码超出 200..599 时
   * 两次构造都抛 `RangeError`(实测 undici 8.10.2 会原样透传 600/999 这类
   * 状态行并给出 body 流)。
   *
   * 此时 `relay.ts` 那层兜底里的 `upstream.body?.cancel()` 会因流已被锁而
   * **异步拒绝** `TypeError: Invalid state: ReadableStream is locked`,
   * 并被它的 `.catch(() => {})` 静默吞掉。实测对照:
   *
   * ```
   * 无 tap: pipe 抛 RangeError | body.locked=false | cancel → resolved
   * 带 tap: pipe 抛 RangeError | body.locked=true  | cancel → REJECTED
   * ```
   *
   * 后果三重且全静默:上游连接泄漏(上界 = `bodyTimeout`,默认 5 分钟)、
   * `onDone` **一次都不触发**(不变量 #3 整条漏掉)、客户端拿到裸 500。
   *
   * 耐久的结论不是"600 状态码要拦一下" —— 那只是今天能找到的一个触发口。
   * 真正坏掉的是 `relay.ts` 承诺的那道通用兜底:**加 tap 之后它结构上不可能
   * 成立**,因为它拿到的 body 已经不是它能释放的那个。所以责任必须回到
   * **锁住流的这一层**:谁锁的谁负责在自己的失败路径上释放。
   *
   * 取消 `outBody`(包装后的流)会经 `tap.ts` 的 cancel 分支传播到上游
   * reader,同时触发 `onDone(非 null)` —— 于是结算方正确地按"不完整"处理,
   * 既不学习也不遗忘。
   */
  const releaseOnFailure = (err: unknown): never => {
    // 只有我们包装过的流才由我们释放;未包装时 body 仍归调用方处置。
    if (tap !== undefined && outBody !== null) {
      void outBody.cancel(err).catch(() => {});
    }
    throw err;
  };

  try {
    return new Response(outBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    try {
      return new Response(outBody, { status: upstream.status, headers });
    } catch (err) {
      return releaseOnFailure(err);
    }
  }
}
