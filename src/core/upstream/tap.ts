/**
 * 响应流旁路观察 —— 让「流结束后的结算」(不变量 #3)有地方挂。
 *
 * ## 为什么必须旁路,不能缓冲
 *
 * 需要结算的信息只能从**响应内容**里读到:SSE 可以带着 HTTP 200 把
 * 「你回放的推理块不是签给你的」塞在流里面,只看状态码整条漏掉。
 * 但本项目是原样透传,不能先把响应读完再转发 —— 那会让一条长 SSE
 * 在网关里憋到结束才开始出字节,客户端看起来完全挂住。
 *
 * 所以这里做一个**透传中转**:字节原样往下游走,同时复制一份解码后的文本
 * 交给扫描器。中转不改变任何字节,也不改变时序。
 *
 * ## 这不违反不变量 #1
 *
 * 不变量 #1 禁止的是「依据响应体决定要不要重试」以及「边写字节边重试」。
 * 本模块不做任何重试决定:它只在流**彻底结束之后**回调一次,
 * 而那时响应早已完整发给客户端,重试已不可能。回调只更新亲和映射。
 */

/** 观察回调。两个都必须是同步且不抛的 —— 见 `tapReadable` 的说明。 */
export type StreamTap = {
  /** 解码后的文本块(仅供扫描;转发的字节不经这里)。 */
  readonly onText: (text: string) => void;
  /**
   * 流结束。`error` 为 null 表示正常读完;
   * 非 null 表示上游中断或客户端取消 —— 此时内容不完整。
   */
  readonly onDone: (error: unknown) => void;
};

/**
 * 扫描预算。
 *
 * 超出之后停止解码与回调(字节照常转发)。没有预算时,一条几百 MB 的
 * 多模态响应会让我们对每个字节做一次解码 + 四条正则 —— 那是纯粹的浪费,
 * 因为我们找的是一条**拒绝消息**,它若存在必然出现在开头附近。
 *
 * 漏判的后果是自纠正的:失效指纹会让下一轮同样失败,而那一轮的拒绝消息
 * 就在开头,预算内必被扫到。
 */
const SCAN_BUDGET_BYTES = 1024 * 1024;

/**
 * 包一层旁路观察。返回的流与入参**逐字节相同**。
 *
 * 用手写 `ReadableStream` 而不是 `TransformStream`:后者在上游出错时
 * 不调用 `flush()`,于是「流异常结束」这一路径拿不到通知 ——
 * 而那正是最需要区分的一种结局(内容不完整,不能据此学习绑定)。
 *
 * 回调里抛出的异常会被吞掉:结算是优化,不该让一个已经成功的响应
 * 在转发到一半时炸掉。
 */
export function tapReadable(
  body: ReadableStream<Uint8Array>,
  tap: StreamTap,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let scanned = 0;
  let finished = false;

  const finish = (error: unknown): void => {
    // 必须幂等:cancel 与 read 的错误路径都可能到这里。
    if (finished) return;
    finished = true;
    try {
      tap.onDone(error);
    } catch {
      /* 结算失败不该影响已经转发出去的响应 */
    }
  };

  const scan = (chunk: Uint8Array): void => {
    if (scanned >= SCAN_BUDGET_BYTES) return;
    scanned += chunk.byteLength;
    try {
      /*
       * `stream: true` 是必须的:UTF-8 的多字节序列会跨块切断,
       * 一次性解码会在边界处产出替换字符 —— 而那正好可能落在我们要匹配的
       * 消息中间,把一次本该命中的扫描变成不命中。
       */
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
        // 先扫描后入队,顺序无关;但**绝不**修改 value。
        scan(value);
        controller.enqueue(value);
      } catch (err) {
        finish(err);
        controller.error(err);
      }
    },
    cancel(reason: unknown) {
      /*
       * 客户端断开(OpenCode 里按 ESC 中断生成)走这条路。
       * 内容不完整,所以 `onDone` 收到非 null —— 结算方据此**不学习**绑定。
       */
      finish(reason ?? new Error("下游取消"));
      return reader.cancel(reason);
    },
  });
}

/**
 * 跨块扫描器。
 *
 * 要找的消息可能正好被切在两块之间,所以每次扫描要带上**上一块的尾巴**。
 * `window` 取所有模式里最长的可能匹配长度 —— 短于它就会漏,
 * 而漏掉的症状是"偶尔不生效",取决于上游的分块位置,极难复现。
 */
export function createOverlapScanner(
  window: number,
  test: (text: string) => boolean,
): { feed: (text: string) => void; hit: () => boolean } {
  let tail = "";
  let hit = false;

  return {
    feed(text: string): void {
      // 命中之后不必继续扫 —— 结论不会因为再命中一次而改变。
      if (hit) return;
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
