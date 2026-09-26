# 协议面细节

SKILL.md 的展开。实现以 `src/server/routes/relay.ts`、`src/core/upstream/` 与
`src/core/protocols/` 为准。

## 七步的理由

| 步 | 细节 |
|---|---|
| 1 | 上限 64 MiB；边读边限，不读完再查（`boundedBody.ts`） |
| 2 | 实测 `{"n":1.0}` 往返后变成 `{"n":1}`，所以只解析副本 |
| 3 | 判定不出免费就拒绝，请求发出后无法收回 |
| 4 | 与第 3 步同属"请求本身"的问题，不用上游调用换已知答案 |
| 5 | 会话绑定在这里用 plan 时刻 |
| 6 | 非最后一次尝试的 body 被取消，最后一次保留给透传 |
| 7 | 手写 `ReadableStream` 旁路复制解码文本给扫描器 |

## 不变量补充

- 不变量 3 的失败形态：plan 绑 w1，重试链静默转到 w2 成功，签发推理块的是 w2；
  不改绑则 w1 冷却结束后客户端回放必被拒。单测模拟的是"冷却发生在 plan 之前"，
  查不出这条。
- 不变量 4：成功只在尝试开始时间晚于冷却时才清除冷却；401 为 `auth`，403 为 `forbidden`。
- 不变量 5：keep-alive 连接复用会击穿锁；桥接统一走 CONNECT 隧道，保证 Clash 在
  切换后重新选路。
- 不变量 6：headers 与 body 超时分开，默认值以 `src/shared/schema.ts` 为准；冷却期
  不包含漫长的等待。
- 不变量 7：只按长度做键时，等长的错口令会撞键，改掉后仍复用旧 dispatcher，鉴权
  永久失败。

## 原样透传

转发的是客户端原始字节，解析只用于路由判定；不能先读完再转发（长 SSE 会憋在网关）。

- 用手写 `ReadableStream` 而不是 `TransformStream`：后者在上游出错时不调 `flush()`，
  拿不到"流异常结束"的通知。
- 解码必须带 `{ stream: true }`：UTF-8 多字节序列会跨块切断。
- 跨块扫描带重叠窗口：拒绝消息可能被切在两块之间，漏检随分块位置时有时无。

结算顺序：检出失效推理 → 解绑并忘掉指纹（即使随后断流）；未检出且 2xx 完整读完 →
学习指纹；其他不完整响应不学习。客户端取消信号贯穿 selector 排队、fetch 与重试链，
取消后不再尝试下一个 Worker。

## 免费判定

免费依据是后缀命中 ∪ `extraFreeIds`；目录存在且 `enforceCatalog` 开启时再与在架
目录求交集。关闭交集不关闭免费依据校验。

- 交集能剔除下架模型，但新出现的无后缀免费模型无法自动发现：上游 `/models` 给在架性
  不给价格。
- 目录缺失时放行并标记 `suffix_unverified` 或 `extra_unverified`：免费依据仍成立，
  缺的只是在架性。人工名单需按上游定价核对。

## 凭证头

匿名 Worker 不发送 `Authorization` 或 `x-api-key`，也不合成占位 Bearer。匿名身份
能否使用某个接口须用真实客户端实测。`messages` 只给 Bearer 时上游返回 500 → 归
`upstream_error` → 可重试且归咎 Worker。见
[`docs/upstream-quirks.md`](../../../docs/upstream-quirks.md#messages-面的凭证头)。

## 客户端验收

手工探针遇到过 `403 FreeTierError`，真实 OpenCode CLI 在有限样本上有成功也有失败；
这些是特定日期、身份、出口和请求形态的观察，不能推广（纪律 #6）。证明流量经过网关
用控制实验：停掉网关 → 同一条命令必须失败 → 重启 → 恢复。方法见
[`docs/usage.md`](../../../docs/usage.md#客户端验收)。
