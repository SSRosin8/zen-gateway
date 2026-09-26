# OpenCode Zen 上游观察

本文件记录在指定日期、指定请求形态和有限样本下观察到的行为。它们不是 Zen 的
永久协议保证。需要重新测量时运行 `npm run discover:upstream`；脚本需要网络，
因此不进入 `npm run validate`。

脚本默认使用免 key 请求。设置 `ZG_DISCOVER_KEY` 时只额外测试免费或不存在的
模型，不发送付费模型请求，以免产生费用。真实客户端的兼容性必须用真实客户端
验证，手工探针不能替代它。

## 免费额度闸门

**观察日期**：2026-09-22 至 2026-09-23。
**形态**：手工向免费模型发送 Chat Completions 请求，未运行完整 OpenCode CLI。

这类请求返回过：

```text
403 application/json
{"type":"error","error":{"type":"FreeTierError",
 "message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}
```

同一请求形态下，语法合法但密钥错误的请求也会得到 403；付费模型则先进入
密钥验证并返回 401。这说明该免费闸门在密钥验证之前短路，不能用 403 推断 key
有效。真实 OpenCode CLI 的请求形态不同，不能由这组手工结果判断 CLI 是否可用。

历史探针曾发送字面量 `Bearer public`，那是旧请求适配层的形态；当前匿名 Worker
不生成该值，也不发送 `Authorization` 或 `x-api-key`。这条历史记录不属于当前
配置要求。

## 请求体检查顺序

**观察日期**：2026-09-23。
**形态**：免 key、免费模型；一份请求的 `messages` 故意是字符串并附带未知字段，
另一份请求完全合法。

两份响应逐字节相同，均为 403 `FreeTierError`。在该形态下无法据此判断上游是否
接受某个请求字段，因为免费闸门先于请求体校验。`discover:upstream` 只把响应
形状作为观察记录，不把它解释成字段级协议结论。

## 模型存在性和鉴权

**观察日期**：2026-09-22 至 2026-09-23。
**样本**：一个虚构的不存在模型 id、一个免费模型和一个付费模型；分别用免 key、
语法非法 key 和明显错误但形状合法的 key 测试。

- 免 key + 不存在模型返回 401 `ModelError`，提示模型不受支持。
- 免 key + 付费模型返回 401 `AuthError`，提示缺少 API key。
- 形状合法但错误的 key + 免费模型仍返回 403 `FreeTierError`。
- 形状合法但错误的 key + 付费模型返回 401 `Invalid credential`。
- 带 key 请求不存在模型时观察到 400 `Model is unavailable`。

因此同一个 401 可能代表模型不存在或缺少凭证，且错误分类依赖模型和请求形态。
网关用本地目录与免费规则提前挡住大多数错误模型名，避免把模型拼写问题归咎于
Worker。

## 错误响应头

**观察日期**：2026-09-22。
**形态**：免 key 请求同一免费模型的错误响应。

401 的 `content-type` 曾为 `text/plain;charset=UTF-8`，响应体却仍是 JSON；403 和
400 的 `content-type` 为 `application/json`。网关原样透传上游头和体，不替上游
修正这个不一致，以便客户端和日志看到真实故障。

## 目录差异

**观察日期**：2026-09-22 至 2026-09-23。
**范围**：三个不同身份、同一出口、连续三轮目录请求。

不同身份看到的总目录数量不同，但本次样本中的免费子集相同。该结果只支持一个
较窄的工程结论：网关可以把免费集作为公共过滤依据，同时仍需缓存带 key 与免
key 的目录槽位。不能由少量样本推断完整目录按某个单一维度分区，也不能把目录
总数写成固定值。

目录的在架性不包含价格信息，所以新出现的无后缀免费模型不能自动发现；需要手工
加入 `models.extraFreeIds`。反过来，符合免费后缀但已下架的模型可由目录交集
自动剔除。

## Messages 面的凭证头

**观察日期**：2026-09-23。
**形态**：向 `/zen/v1/messages` 发送免费模型请求，只改变凭证头。

只带 `Authorization: Bearer ...` 时曾返回 500；带 `x-api-key`（或两个头）时到达
403 免费闸门。`anthropic-version` 是否存在不改变该结果，但协议要求由网关统一
设置，不能直接信任客户端传入的旧版本号。

当前网关对非空认证 Worker 同时提供两个上游凭证头；匿名 Worker 两个头都为空。
历史 500 不足以证明所有匿名或真实 CLI 请求都会失败，最终兼容性仍由真实客户端
验收。

## Responses 亲和

**观察日期**：实现集成测试与真实 CLI 验证期间。
**范围**：完整成功 Responses 响应和带 `previous_response_id` 的后续请求。

后续请求优先使用 `previous_response_id` 作为会话提示。完整成功响应中的
`response.id` 会绑定实际承接该响应的 Worker；失效推理或中途失败响应不会学习新
绑定。这样重试链从第一个候选切换到另一个 Worker 时，后续请求仍跟随真正签发
推理状态的 Worker。

## 真实 OpenCode CLI 与多出口

**客户端**：OpenCode CLI v2.0.12，使用原生 `opencode run --standalone --format json`。

隔离 mock 确认 `providers.opencode.settings` 足以覆盖 Base URL 和 API key；当前推荐配置
只覆盖这两个连接设置，保留 OpenCode 自己的 SDK package 和模型目录。客户端模型目录中
没有的模型会在 CLI 侧报 `Model unavailable`，不应归因于网关。

以下测量都在 2026-09-26 进行，测试没有输出 key、出口名称或公网 IP。

| 请求范围 | 结果 | 不能推出的结论 |
|---|---|---|
| 多出口矩阵：验收夹具显式补了逐模型 package/settings；3 个未绑定到当前 Worker 的临时 Clash 出口 × 3 把已配置认证 key 和 1 个临时构造的不发送 key 的匿名 Worker × 4 个免费模型，共 48 次经网关请求；每次都在 Clash `/connections` 中核对到 `opencode.ai`、所选临时出口链路且不是 `DIRECT` | `mimo-v2.6-flash-free`、`big-pickle`、`space-bunny-free` 的 Chat Completions 与 `muse-spark-1.3-contributor-free` 的 Responses 均返回 `OK`；网关在多个真实命中的出口上转发，并保持认证与匿名 Worker 的凭证选择 | 客户端必须覆盖模型目录（当前接入只用 provider 连接设置）；其他出口同样可用（仍可能受地域限制） |
| 用户默认 OpenCode 会话与网关日志 | 分别观察到 MiMo、Big Pickle 的成功用量；默认会话中 Muse Spark 受地域限制，而经网关的该轮出口样本成功 | 一次地域拒绝可推广到所有出口；两者矛盾（地域限制是出口与上游策略的组合结果） |
| 旧矩阵：同时启用 OpenCode 权限拒绝规则，并做逐变量控制实验 | 旧矩阵得到 403；控制实验显示关键变量是该权限规则，空的 XDG 目录本身不构成失败原因 | 旧矩阵的 403 代表上游可用性 |
| 匿名专项复核：三个真实出口，每次只启动一个匿名 Worker；每个 CLI 进程设置 `PWD`、绝对 `OPENCODE_CONFIG`、隔离 XDG 目录和全新会话 | Big Pickle、Space Bunny Chat 在三个出口上均返回 `200`；MiMo 在该隔离客户端目录中未注册，CLI 直接报 `Model unavailable`，没有发出网关请求；Muse Spark Responses 均因当前地域策略返回 `403`；三个临时运行库都只出现对应的匿名 Worker，未出现认证 Worker | MiMo 不能经网关匿名使用（请求未发出）；Muse 的 403 与 Worker 类型有关 |
| 规则调整前的对照（OpenCode CLI v2.0.12，隔离配置与状态目录，3 个认证 Worker）| Big Pickle、Nemotron 3 Ultra 的 Chat Completions 与 Muse Spark 1.3 的 Responses 经网关返回 `OK`；`space-bunny-free`、`mimo-v2.5-free` 在该客户端目录中未注册，CLI 报 `Model unavailable`。当时 Clash `/connections` 显示 `opencode.ai` 被企业 DNS 解析到内网地址，命中私网 `IPCIDR → DIRECT`，即调整规则之前各 Worker 的 Zen 请求共用直连出口；这是下一节控制实验的前态，不是当前状态 | 网关的出口绑定在该前态下已对 Zen 生效；回显报告各自独立即可证明 Zen 请求已隔离 |
| 匿名 `/v1/models` 的 CA 对照 | 服务进程未设置 `NODE_EXTRA_CA_CERTS` 时返回 `502 upstream_unreachable`；带上服务使用的 CA 后返回 `200`，目录槽位为 `keyless` | 502 与出口/上游策略有关，或上述地域 403 与信任库有关；两类条件不能互相归因 |

### 全新克隆到多出口真实 CLI 验收（2026-09-26）

**环境**：全新克隆 → `npm install` → `npm start`（默认端口 9876）→
`npm run setup -- --api <本机 Controller> --secret <secret>`，接入 1 个本机 mihomo
内核并导入 69 个节点 → 通过 `PATCH /api/config` 新建 3 个认证 Worker 和 3 个匿名
Worker，各绑定一个不同的 Clash 节点 → `npm run doctor` 各层通过 →
`POST /api/probe` 6/6 成功，回显报告为 6 个不同的回显 IP。

**客户端**：OpenCode CLI v2.0.12，`opencode run --standalone`，每次运行使用隔离的
`PWD`、`OPENCODE_CONFIG`、XDG 目录和全新会话；每轮只启用一个 Worker。

| 模型（协议面） | 6 个 Worker 上的结果 |
|---|---|
| `big-pickle`（Chat Completions） | 全部 `OK` |
| `nemotron-3-ultra-free`（Chat Completions） | 全部 `OK` |
| `muse-spark-1.3-contributor-free`（Responses） | 5 个 `OK`；1 个匿名 Worker 收到 403 `This model is not available in your country`（地域拒绝，网关分类为 `forbidden`，短冷却；当时 403 不换 Worker 重试） |
| `mimo-v2.6-flash-free` | CLI 报 `Model unavailable`：客户端目录没有该模型，未发出上游请求 |

每次上游尝试都落在当轮启用的 Worker 上；同期 Clash `/connections` 中目标为
`opencode.ai` 的连接走该 Worker 自己的节点，命中的是 `DomainSuffix` 规则。

**403 换 Worker 重试的复核**：之后把 `forbidden` 改为可换 Worker 重试，全部 Worker
启用、全新会话下再发同一个 Muse Spark 请求：首个尝试在上述匿名 Worker 上得到 403，
同一请求的第二个尝试换到另一个匿名 Worker 返回 `200`，CLI 输出 `OK`。这只证明该组
出口中存在可用出口时重试能绕过地域拒绝，不证明所有 403 都能靠换出口解决（免费闸门
的 403 换 Worker 仍会失败）。

**控制变量**：在 Clash 规则最前面加入 `DOMAIN-SUFFIX,opencode.ai,<分组>` 之前，
企业 DNS 把 `opencode.ai` 解析到私网 `10.x` 地址，排在前面的私网 `IPCIDR → DIRECT`
先命中，所有 Zen 请求直连（见上表“规则调整前的对照”）。加入规则后 Zen 连接改走
各自节点。`npm run doctor` 第 5 层现在会检测这种首条命中不经过所选分组的情况。

**不能推出的结论**：

- 其他账号、其他时间或其他地区的出口会得到相同结果；地域拒绝取决于出口所在地和
  上游当时的策略。
- 这次 403 与 Worker 是匿名还是认证有关（只有一个样本，且与出口节点混在一起）。
- Messages 面在真实 CLI 下可用（本轮未测）。
- 客户端目录外的模型经网关是否可用（请求未发出）。
- 没有前置 `DOMAIN-SUFFIX` 规则的其他 Clash 配置也会走所选节点。

当前没有可用于 Messages 真实验收的免费模型；Messages 仍只有本地协议级验证，等待
上游提供可验模型。

## 重新测量的边界

`discover:upstream` 使用 Node 的网络栈和它自己的环境变量，不能证明服务进程的
CA、代理、DNS、超时或请求头与脚本完全相同。验证网关时应运行服务进程并使用真实
客户端；出口归属见 [回显 IP 的测量范围](usage.md#回显-ip-的测量范围)。
