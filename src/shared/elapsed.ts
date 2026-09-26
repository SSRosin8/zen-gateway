/**
 * 耗时测量 —— 凡是 `clock() - startedAt` 的地方都走这里。
 *
 * ## 为什么要夹
 *
 * `clock` 是**可注入的**（测试要控时钟），而"这个参数只有测试会传奇怪的值"
 * 不是一个能长期依赖的前提。生产上 `Date.now` 也会被 NTP 回拨。
 *
 * 两个后果都实测过：
 *
 * - **非整数丢整行**：`probe_results.latency_ms` 与 `upstream_attempts.latency_ms`
 *   都是 STRICT 表的 INTEGER 列，`1.5` 被拒后**整条事务回滚** ——
 *   明细与累计一起丢，只留一个 `writeFailures` 计数。
 * - **负数照常入库**，随后 `ProbeResultSchema` 的 `.int().nonnegative()` 在
 *   `parse` 时抛，而那个 parse 排在 `applyConfig` **之后**：配置已经写盘，
 *   客户端只收到一个「网关内部错误」。
 *
 * 理由与 `usage.ts` 的 `clampTokens` 同源：宁可夹住，不要让一个调用方
 * 能控制的数值把存储层搞坏。
 *
 * ## 为什么在 `shared/`
 *
 * `upstream/retry.ts` 与 `proxy/probe.ts` 都要测耗时 —— 两个 core 子目录
 * 各写一遍（一份私有实现、一份裸减法）就是纪律 #4 的形态，
 * 而分叉方向是漏：加第三个测量点时没人会想起来夹。
 */
export function elapsedMs(clock: () => number, startedAt: number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}
