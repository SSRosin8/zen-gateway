---
name: protocol-surface
description: Use when adding or changing a client protocol surface (chat / responses / messages), touching the relay request pipeline, retry/cooldown behaviour, or free-model gating. Encodes the seven control-flow invariants and the order the seven relay steps must keep. Trigger on 协议面, 转发, relay, 重试, 冷却, 免费判定, surface, retry, cooldown, streaming, SSE, 透传.
---

# 协议面与转发链

## 新增一个面 = 加一个文件 + 注册一行

验收条件已经兑现过一次（Phase 6 加 `responses` + `messages`，
`src/server/` 下唯一的改动是 `buildRegistry()` 里那两行 `.register()`）。

路由由 `registry.paths()` **动态挂载**，鉴权守卫的挂载点也从同一个注册表
推导 —— 所以加一个面自动多一道守卫。

**任何地方出现 `if (id === "chat")` 这类分支，抽象就已经漏了。**

> 对比第四轮审核：那时守卫是手写的三条路径字面量，按注释承诺的形态注册
> 两个面之后，`/responses` 与 `/messages` 两条无前缀别名**完全绕过鉴权**。

注册时就查路径冲突（含面内重复）：两个面声明同一个 `clientPaths` 时请求会
被先注册者接走，而**这在测试里通常看不出来** —— 两个面的最小请求可能都能
成功，只是其中一个悄悄走错了上游路径。症状是「某些模型偶尔报错」。

## 七步的顺序不可调换

`server/routes/relay.ts`：

| # | 步骤 | 为什么在这个位置 |
|---|---|---|
| 1 | 读**原始字节**（只读一次） | 转发出去的必须是客户端的原始字节 |
| 2 | 解析一份**副本**做判定 | `JSON.parse`→`stringify` 往返**不是无损的**（实测 `{"n":1.0}` → `{"n":1}`） |
| 3 | 免费判定 | 放行付费模型的代价是真金白银，且请求发出无法收回 |
| 4 | 流式能力校验 | 面声明 `streaming: "none"` 时拒绝流式请求 |
| 5 | 选 Worker | 粘滞/冷却在这里收口 |
| 6 | 重试链 | 只看 status + headers，**body 不消费** |
| 7 | 流式透传（带旁路结算钩子） | **唯一**写出客户端字节的地方 |

第 3、4 步都判定"请求本身"的问题，在本机就能定论 —— 不该花一次上游调用去
换一个已知的答案。

## 七条控制流不变量

第八轮逐条变异确认过：**七条都成立，且七条都有真会失败的测试**。
改这一层之前先读它们，改完重跑对应的变异。

1. **重试与透传分层**：重试决定发生在 body 被 pipe **之前**。
   `retry.ts` 没有任何写字节的路径，`pipe.ts` 没有重试分支 —— 由目录划分强制。
2. **body 取消的不对称**：取消在途的 body 与在 headers 之前取消不同。
   `retry.ts` 对非最后一次尝试取消 body，对最后一次**保留**。
3. **流末尾结算**：加密推理指纹在**流结束时**学习，会话绑定 rebind 到
   **实际承接者**而不是候选链首位。`plan` 绑 w1 而重试链静默转到 w2 成功时，
   签发推理块的是 w2 —— 不改绑则 w1 冷却结束后客户端回放必被拒。
   **这个缺陷只有集成测试查得出来**（单测模拟的是"冷却发生在 plan 之前"）。
4. **不可重试的 4xx 记成功**：那是上游的真实回答，不是 Worker 的故障。
   `blameWorker = failure !== "bad_request"`，而分支判据从 `shouldCooldown`
   推导（单一真相）。
5. **selector 锁的范围**：`fetch.ts` 返回 Response 而**不是**读完 body 的
   promise —— keep-alive 连接复用会击穿锁，所以 `nodeName` 必须参与
   dispatcher 的缓存键。
6. **headers/body 超时分开，三个时刻分开**：会话绑定用 **plan** 时刻、
   冷却用**失败**时刻、指纹学习用**流结束**时刻。
   前提事实：`bodyTimeoutMs` 默认 300000 > `transportMaxMs` 上限 120000，
   所以单一 `now` 的设计会让 **body 空闲超时的 Worker 永不冷却**。
7. **每节点一个 dispatcher**，键含 sha256 凭证指纹（**不是长度** ——
   等长的错口令会撞键，于是"改掉一个等长的错口令"后仍复用旧 dispatcher，
   鉴权永久失败）。

## 原样透传是设计前提

转发出去的是客户端发来的**原始字节**，解析只用于路由判定。

所以不能"先读完再转发"（长 SSE 会憋在网关里），而流末尾的结算钩子做的是
**旁路中转**：字节原样往下游走，同时复制一份解码文本给扫描器。
三条实现约束，每条对应一个会静默失败的坑：

- **手写 `ReadableStream` 而不是 `TransformStream`**：后者在上游出错时不调
  `flush()`，于是"流异常结束"拿不到通知 —— 而那正是最需要区分的结局。
- **解码必须 `{ stream: true }`**：UTF-8 多字节序列会跨块切断。
- **跨块扫描要带重叠窗口**：拒绝消息可能被切在两块之间，而漏掉的症状
  取决于上游的分块位置 —— 时有时无，极难复现。

结算三种结局：检出失效推理 → 解绑 + 忘掉指纹；2xx 且**完整读完** →
学习指纹；**不完整**（断流/客户端按 ESC）→ **什么都不做**。

## 免费判定

**（后缀命中 ∪ `extraFreeIds`）∩ 在架目录**。交集是已下架 id 自动失效的
**唯一**机制。

**不对称要记住**：交集能自动剔除下架的，但**新出现的无后缀免费模型无法
自动发现** —— 上游 `/models` 给在架性却不给价格。

**目录缺失时放行而不是拒绝**，与"默认拒绝"不冲突：默认拒绝针对"判定不出
免费"（放行代价是钱），而目录缺失时免费依据仍成立，缺的只是"是否还在架"，
后果只是上游拒绝、不产生费用。反过来做的话一次上游抖动会让网关拒绝一切。

## 各面独有的坑

| 面 | 独有的事 |
|---|---|
| `chat` | 无体内会话标识，亲和只能靠 `x-opencode-session` |
| `responses` | `previous_response_id` 是**体内**会话指针，优先于头 |
| `messages` | 必须把 key 镜像到 `x-api-key`，并发 `anthropic-version` |

`messages` 那条的失败方式最糟：只给 Bearer 时上游返回 **500** →
归 `upstream_error` → 可重试且**归咎 Worker** → 客户端一用 Messages 面就把
整池 Worker 打进冷却。详见 `docs/upstream-quirks.md` §8。

## 验证只能用真实 OpenCode CLI

免费额度闸门**查请求形态不查 key**，手搓 `curl` 必然得到
`403 FreeTierError` —— 那是**预期行为而非故障**，所以"curl 打不通"
不构成端到端失败的证据。

且证明"流量真的经过网关"要用**控制实验**（停掉网关 → 同一条命令必须失败
→ 重启 → 恢复），而不是读日志。
