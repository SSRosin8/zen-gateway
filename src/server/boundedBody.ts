/**
 * 有界读取请求体 —— 转发面与管理面共用。
 *
 * ## 为什么"读完再量"不算上限
 *
 * 两处先前都是 `await c.req.arrayBuffer()` 然后 `if (byteLength > 上限)`。
 * 那个顺序下**整个体已经在内存里了**，上限只限制"转发出去多少"，
 * 不限制"占用多少"。第十轮审核实测：64 MiB 的闸门下发 200 MiB，
 * 网关照旧读入 200 MiB 才返回 413。
 *
 * 威胁模型不是远端 —— 网关只监听回环 —— 而是**本机上的其他进程**
 * （浏览器里的恶意页面经 fetch 打本地端口、装错的 npm 包），
 * 那正是 `relayAuth.ts` 文件头写明的那一组。它们能拿到 token 的场景下
 * 也能发大请求，而几个并发就能把进程推到 Node 的默认堆上限。
 *
 * ## 为什么不能只看 `content-length`
 *
 * 那个头**可以撒谎**，chunked 编码也根本不给。管理面先前查了它（挡住了
 * 声称超限的），但 `transfer-encoding: chunked` 绕过整条检查。
 * 所以判据只能是"边读边数"。
 *
 * 与 `core/models/catalog.ts` 的 `readBoundedText` 是同一个做法；
 * 两处刻意不共用一个函数：那边拿的是 undici 的响应流、要解码成文本，
 * 这边拿的是 Hono 的请求流、要原始字节（转发面必须原样透传）。
 */

/**
 * 超限时抛这个，调用方据此返回 413。
 *
 * 不用构造器参数属性 —— 理由与 `store/config.ts` 的 `ConfigError` 同源
 * （Node 的 strip-only TS 模式不支持那个语法，而 `tsc` 与 Vitest 都拦不住它）。
 * 那里写得更细，不在这里存第二份。
 */
export class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
  readonly limit: number;

  constructor(limit: number) {
    super(`请求体超过 ${limit} 字节`);
    this.limit = limit;
  }
}

/**
 * 边读边计数地把请求体读成字节。超过 `limit` 立刻取消并抛 `BodyTooLargeError`。
 *
 * `body === null` 的请求（GET/HEAD，或没有体的 POST）返回空数组 ——
 * 调用点已有"体为空"那条出口，不在这里重复判断。
 */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > limit) {
        /*
         * 取消上游读取 —— 不取消的话客户端会继续把剩下的字节推进来，
         * 而我们已经决定不要了。`catch` 吞掉取消本身的失败：
         * 此时要报给调用方的是"超限"，而不是"取消时又出了个错"。
         */
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  /*
   * 拼接时**一次性分配**目标数组，而不是反复 `concat`。
   * 反复拼接会让峰值占用变成体积的若干倍 —— 而这个函数存在的理由正是
   * 控制峰值占用，那种实现会把自己要解决的问题重新引入一遍。
   */
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
