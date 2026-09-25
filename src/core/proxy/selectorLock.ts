/**
 * Clash selector 互斥锁。
 *
 * 桥接出口的根本约束:**所有桥接代理都经同一个本地混合端口出去**,
 * 具体走哪个节点由 Clash 的 selector 分组状态(`now`)决定 —— 那是全局状态。
 * 两个并发请求若各自切换 selector,就会互相换掉对方的出口节点,
 * 于是 Worker A 的流量从 Worker B 的 IP 出去,出口隔离彻底失效。
 *
 * 因此「切换 selector + 建立连接」必须在同一把锁内。
 *
 * 但锁**必须在响应体开始流之前释放**:一条 SSE 可能持续几分钟,
 * 若锁跨到流结束,整个网关会被单条长连接串行化。
 *
 * 临界区的正确边界恰好就是 `fetch()` 的 resolve 时机 ——
 * 它在响应头到达时 resolve,此时连接已建立并绑定到当时选中的节点,
 * 之后再切换 selector 不会改变这条已建立连接的出口。
 *
 * ## 陷阱:Promise 同化会把锁的范围悄悄扩大
 *
 * `run()` 内部靠 `.then()` 串行,而 `.then()` **会自动 await 任务返回的 Promise**。
 * 因此:
 *
 *   ✅ `run(() => fetch(url))`        —— 返回 `Promise<Response>`,锁持到响应头到达。
 *                                        Response 本身不是 Promise,body 是它上面的流,
 *                                        之后读 body 在锁外。
 *   ❌ `run(async () => { const r = await fetch(url); return r.text(); })`
 *                                     —— 返回的是读体的 Promise,**锁会一直持到
 *                                        整个响应体读完**,一条长 SSE 就此串行化
 *                                        整个网关。
 *
 * 区别只在返回值是「响应对象」还是「读体的 Promise」,不看类型签名极易写错。
 * Phase 3 的转发链路照抄本模式时尤其要注意:任务里只做「切换 + 建连」。
 *
 * 直连代理没有这个约束(各自独立的 dispatcher),不走这把锁。
 */

/** 每个 Clash 内核一把锁 —— 不同内核的 selector 彼此独立。 */
export class SelectorLock {
  /** 锁链的尾部;新任务排在它后面。 */
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** 正在排队或执行的任务数,供诊断与测试观察。 */
  get pending(): number {
    return this.#depth;
  }

  /**
   * 串行执行 `task`。
   *
   * `task` 应当只包含「切 selector + 建立连接」,不要把消费响应体也放进来。
   * 若信号在排队期间取消,任务不会开始；这点必须在锁层处理,否则客户端断开
   * 后排队的请求仍会切换全局 selector,造成与任何实际请求都无关的出口抖动。
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#depth += 1;

    const execute = (): Promise<T> => {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("操作已取消", "AbortError"));
      return task();
    };

    // 接在当前尾部之后;用 then 的两个分支保证前一个任务失败也不会断链。
    const result = this.#tail.then(execute, execute);

    // 尾部换成「本任务完成」,且吞掉结果与异常 ——
    // 否则一次失败会让后续所有任务都被同一个 rejection 拖挂。
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.#depth -= 1;
    });
  }
}

/** 按内核 id 管理锁;内核之间互不阻塞。 */
export class SelectorLockRegistry {
  #locks = new Map<string, SelectorLock>();

  forBridge(bridgeId: string): SelectorLock {
    let lock = this.#locks.get(bridgeId);
    if (!lock) {
      lock = new SelectorLock();
      this.#locks.set(bridgeId, lock);
    }
    return lock;
  }

  get size(): number {
    return this.#locks.size;
  }
}
