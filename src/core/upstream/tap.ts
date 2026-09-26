/**
 * 响应流旁路观察,让「流结束后的结算」(不变量 #3)有地方挂。
 *
 * 结算信息只在响应内容里(SSE 可带着 200 在流中拒绝推理块),但原样透传不能先缓冲。
 * 所以字节原样往下游走,同时把解码文本交给扫描器,不改字节与时序。
 * 不违反不变量 #1:只在流彻底结束后回调一次,不做重试决定,只更新亲和映射。
 */

/** 观察回调,都必须同步且不抛。 */
export type StreamTap = {
  /** 解码后的文本块(仅供扫描;转发的字节不经这里)。 */
  readonly onText: (text: string) => void;
  /** 流结束。`error` 为 null 表示正常读完;非 null 表示上游中断或客户端取消,内容不完整。 */
  readonly onDone: (error: unknown) => void;
};

/**
 * 失效推理扫描的预算,只属于扫描器,不属于 `onText`。
 *
 * 拒绝消息必然在开头附近,漏判也会在下一轮自纠正。但 `onText` 还服务 token 用量,
 * 用量需要整条流(chat/responses 在末帧,Anthropic 拆在两端);预算若加在 `onText` 上,
 * 长流的用量会丢失或算错。所以由 `createOverlapScanner` 自己计数。
 */
const DEFAULT_SCAN_BUDGET_BYTES = 1024 * 1024;

/**
 * 包一层旁路观察,返回的流与入参逐字节相同。
 *
 * 用手写 `ReadableStream` 而不是 `TransformStream`:后者在上游出错时不调用 `flush()`,
 * 拿不到「流异常结束」的通知。回调异常被吞掉:结算是优化,不能炸掉已成功的响应。
 */
export function tapReadable(
  body: ReadableStream<Uint8Array>,
  tap: StreamTap,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  /** 已解码字节数,不是预算,只用于判断收尾要不要 flush。 */
  let decoded = 0;
  let finished = false;

  const finish = (error: unknown): void => {
    // 必须幂等:cancel 与 read 的错误路径都可能到这里。
    if (finished) return;

    /*
     * 收尾 flush decoder 里残留的不完整多字节序列,否则流的最后一个字符永远看不到。
     * 必须在 `finished = true` 之前(`scan` 有 finished 守卫);这里不能加预算条件,
     * 超长流的末尾恰是 chat/responses 用量的所在。
     */
    if (decoded > 0) {
      try {
        const tail = decoder.decode();
        if (tail !== "") tap.onText(tail);
      } catch {
        /* 同 scan:解码问题不影响已转发的响应 */
      }
    }

    finished = true;
    try {
      tap.onDone(error);
    } catch {
      /* 结算失败不该影响已经转发出去的响应 */
    }
  };

  const scan = (chunk: Uint8Array): void => {
    /*
     * `finished` 之后不再扫描,保证 `onText` 不越过 `onDone`:结算在 `onDone` 里采样
     * `scanner.hit()`,越界的命中会丢失 `staleHit`。真实 reader 不可达,属纵深防御。
     * 这里刻意没有字节预算(见 `DEFAULT_SCAN_BUDGET_BYTES`)。
     */
    if (finished) return;
    decoded += chunk.byteLength;
    try {
      // `stream: true` 必需:多字节序列跨块切断时,一次性解码会在边界产出替换字符。
      const text = decoder.decode(chunk, { stream: true });
      if (text !== "") tap.onText(text);
    } catch {
      /* 解码失败(不该发生,fatal 为 false)不影响转发 */
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(null);
          controller.close();
          return;
        }
        // 绝不修改 value。
        scan(value);
        controller.enqueue(value);
      } catch (err) {
        finish(err);
        controller.error(err);
      }
    },
    cancel(reason: unknown) {
      // 客户端断开:内容不完整,`onDone` 收到非 null,结算方据此不学习绑定。
      finish(reason ?? new Error("下游取消"));
      return reader.cancel(reason);
    },
  });
}

/**
 * 跨块扫描器。每次扫描带上上一块的尾巴,`window` 须不短于最长可能匹配,否则按分块位置偶发漏检。
 * 超出 `budget` 后停止跑正则(理由见 `DEFAULT_SCAN_BUDGET_BYTES`)。
 * 计的是字符数而非字节数,作为防浪费的粗阈值足够。
 */
export function createOverlapScanner(
  window: number,
  test: (text: string) => boolean,
  budget: number = DEFAULT_SCAN_BUDGET_BYTES,
): { feed: (text: string) => void; hit: () => boolean } {
  let tail = "";
  let hit = false;
  let scanned = 0;

  return {
    feed(text: string): void {
      // 命中之后不必继续扫。
      if (hit) return;
      // 预算耗尽后不再跑正则。字节照常转发,用量照常收集。
      if (scanned >= budget) return;
      scanned += text.length;
      const combined = tail + text;
      if (test(combined)) {
        hit = true;
        tail = "";
        return;
      }
      tail = combined.length > window ? combined.slice(-window) : combined;
    },
    hit(): boolean {
      return hit;
    },
  };
}
