/**
 * 有界读取请求体，转发面与管理面共用。「读完再量」时整个体已在内存里，
 * 只看 `content-length` 又会被 chunked 编码绕过，所以只能边读边数。
 * 威胁模型是本机其他进程（见 `relayAuth.ts`），几个并发大请求就能撑爆堆。
 * 与 `catalog.ts` 的 `readBoundedText` 刻意不共用：那边解码 undici 响应为文本，这边要原始字节。
 */

/**
 * 超限时抛出，调用方据此返回 413。不用构造器参数属性，理由见 `store/config.ts` 的 `ConfigError`。
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
 * `body === null` 时返回空数组，由调用点的「体为空」出口处理。
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
        // 取消读取，不让客户端继续推字节；吞掉取消本身的失败，要报的是「超限」。
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // 一次性分配目标数组，避免反复 concat 让峰值占用成倍。
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
