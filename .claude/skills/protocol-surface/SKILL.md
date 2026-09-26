---
name: protocol-surface
description: 约束 zen-gateway 的协议面与转发请求链。在新增或修改 chat、responses、messages 协议面，或改动转发顺序、重试、冷却、免费模型判定、会话亲和、取消传播和流式透传时使用；给出七步处理顺序、七条控制流不变量和各面的凭证头差异。
---

# 协议面与转发链

新增协议面 = 在 `src/core/protocols/` 加一个面文件 + 在 `buildRegistry()` 注册一行。
路由与鉴权挂载都从 `registry.paths()` 推导（纪律 #4）；出现 `if (id === "chat")`
这类分支说明抽象漏了。注册时检查 `clientPaths` 冲突，否则先注册者会静默接走请求。

## 七步顺序（`src/server/routes/relay.ts`，不可调换）

1. 有界读取原始字节：边读边计数，超限立即中止，不信任声明的长度（纪律 #13）。
2. 解析一份副本做判定；转发仍用原始字节，`JSON.parse`→`stringify` 不是无损的。
3. 免费判定：放行付费模型的代价无法收回。
4. 流式能力校验：面声明 `streaming: "none"` 时拒绝流式请求。
5. 选 Worker：粘滞与冷却在这里收口。
6. 重试链：只看 status 与 headers，不消费 body。
7. 流式透传（带旁路结算）：唯一写出客户端字节的地方。

第 3、4 步在本机就能定论，不花上游调用。

## 七条控制流不变量

每条都应有能失败的测试；改动后重跑相关测试。

1. **重试与透传分层**：重试决定在 body 被 pipe 之前；`retry.ts` 不写字节，`pipe.ts`
   不重试。
2. **body 取消不对称**：`retry.ts` 对非最后一次尝试取消 body，最后一次保留。
3. **流末尾结算**：推理指纹在流结束时学习，会话 rebind 到实际承接的 Worker 而不是
   候选链首位。只有集成测试查得出来。
4. **不归咎 Worker 的失败**：`bad_request` 与出口配置错误不改连续失败计数、保留已有
   冷却；`Scheduler.record()` 结合 `blameWorker` 与 `shouldCooldown` 判定。`auth` 与
   `forbidden` 仍冷却，`forbidden` 另换 Worker 重试。
5. **selector 锁的范围**：锁只覆盖切换 selector 与建立连接；`fetch.ts` 返回 Response
   而不是读完的 body，所以 `nodeName` 必须进 dispatcher 缓存键。
6. **三个时刻分开**：会话绑定用 plan 时刻、冷却用尝试结束时刻、指纹学习用流结束时刻；
   响应头到达即结算，后续 body 断流不另记失败。
7. **每节点一个 dispatcher**：缓存键含 `credentialFingerprint`（sha256，不是长度）。

## 各面差异

| 面 | 差异 |
|---|---|
| `chat` | 无体内会话标识，亲和只靠 `x-opencode-session` |
| `responses` | `previous_response_id` 优先于头；完整成功响应的 id 绑定实际 Worker |
| `messages` | 认证 key 镜像到 `x-api-key`，始终发送 `anthropic-version` |

匿名 Worker 不发送任何上游凭证头。`messages` 只给 Bearer 时上游返回 500，会被归咎
Worker 并把整池打进冷却。

透传实现约束、免费判定规则和客户端验收方法见 [reference.md](reference.md)。
