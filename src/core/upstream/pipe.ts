import type { Response as UndiciResponse } from "undici";
import { tapReadable, type StreamTap } from "./tap.ts";

/**
 * 流式透传,唯一写出客户端响应字节的地方。
 *
 * 不变量 #1 的另一半:`retry.ts` 只判重试不写字节,本文件只写字节不判重试,
 * 让「发过字节后又重试」写不出来。body 不经 `JSON.parse`/`stringify` 往返(那不是无损的)。
 * 响应头过滤逐跳头与 `content-encoding`/`content-length`:undici 已解压响应体。
 */

/** 不得转发给客户端的响应头(小写)。 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-connection",
  // undici 已解压响应体,这两个头描述的是压缩前的形态。
  "content-encoding",
  "content-length",
]);

/**
 * 把上游响应转成给客户端的响应,body 原样流式透传。
 * `extraHeaders` 是网关诊断头,在过滤之后写入。
 *
 * 对畸形头容错而非抛错:此时上游已成功并计费,抛出只会得到裸 500 且流未释放。
 * 头名/值来自上游,`headers.set()` 可能抛;跳过该头照常转发。
 */
export function pipeUpstreamResponse(
  upstream: UndiciResponse,
  extraHeaders?: Readonly<Record<string, string>>,
  /** 旁路观察(不变量 #3 的挂点),不改字节与时序。目录查询与测试不需要结算,故可选。 */
  tap?: StreamTap,
): Response {
  const headers = new Headers();

  upstream.headers.forEach((value, name) => {
    if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
    try {
      headers.set(name, value);
    } catch {
      // 上游头含 CR/LF 或非法 token 字符:跳过这一个。
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
   * body 不读、不拷贝、不反序列化;传了 `tap` 时经旁路中转(见 `tap.ts`)。
   * 204/304 与 HEAD 没有 body,必须传 null,否则 Response 构造会拒绝。
   */
  const body = upstream.body as ReadableStream<Uint8Array> | null;
  const hasBody = body !== null && upstream.status !== 204 && upstream.status !== 304;

  // 无 body 时也要通知结算方一次,否则 `settleStream` 永远等不到完成,静默丢掉绑定学习。
  const outBody = hasBody && tap !== undefined ? tapReadable(body, tap) : hasBody ? body : null;
  if (!hasBody && tap !== undefined) {
    try {
      tap.onDone(null);
    } catch {
      /* 结算失败不影响响应本身 */
    }
  }

  /*
   * `statusText` 来自上游,可能畸形;失败时退回不带 statusText 的构造。
   *
   * 两次都失败(如状态码超出 200..599)时必须由本函数释放流:`tapReadable` 已锁住上游 body,
   * `relay.ts` 兜底的 `upstream.body?.cancel()` 会因流被锁而静默失败,导致连接泄漏、
   * `onDone` 不触发。谁锁的谁释放;取消 `outBody` 会经 tap 的 cancel 分支传到上游并触发 `onDone(非 null)`。
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
