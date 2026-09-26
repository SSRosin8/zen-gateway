/**
 * 持久化写失败的吞掉与计数。三个 store 共用：写失败不能让转发或探测失败，
 * 但必须经 `/health` 的 `storeWriteFailures` 可诊断。
 */
export class WriteFailures {
  #count = 0;
  #lastError: string | null = null;

  /** 执行 `fn`；抛错时计数并记下最后一条原因，不向上抛。 */
  guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#count += 1;
      this.#lastError = `${what}: ${err instanceof Error ? err.message : "未知错误"}`;
    }
  }

  snapshot(): { count: number; lastError: string | null } {
    return { count: this.#count, lastError: this.#lastError };
  }
}
