/**
 * Clash selector 互斥锁。
 *
 * 所有桥接代理经同一个混合端口出去,节点由全局的 selector `now` 决定;并发切换会让
 * Worker A 的流量从 Worker B 的 IP 出去。因此「切换 selector + 建立连接」必须在同一把锁内,
 * 且锁必须在响应体开始流之前释放,否则一条长 SSE 会串行化整个网关。
 * 临界区最晚到 `fetch()` resolve(连接已绑定节点);转发路径在连接就绪时就释放(见 `upstream/fetch.ts`)。
 *
 * 陷阱:`.then()` 会同化任务返回的 Promise。`run(() => fetch(url))` 只持锁到响应头;
 * `run(async () => (await fetch(url)).text())` 会持锁到响应体读完。任务里只做「切换 + 建连」。
 * 直连代理各有独立 dispatcher,不走这把锁。
 */

/** 每个 Clash 内核一把锁 —— 不同内核的 selector 彼此独立。 */
export class SelectorLock {
  /** 锁链的尾部;新任务排在它后面。 */
  #tail: Promise<unknown> = Promise.resolve();

  /**
   * 串行执行 `task`(只含「切 selector + 建连」)。
   * 排队期间信号取消则不开始:否则客户端断开后排队请求仍会切换全局 selector,造成出口抖动。
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const execute = (): Promise<T> => {
      if (signal?.aborted) return Promise.reject(signal.reason);
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

    return result;
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
}
