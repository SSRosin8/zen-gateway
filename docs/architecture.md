# 架构说明

本文说明当前代码的结构、数据流和运行边界。它面向维护、排查和验收本工具的人，不依赖其他项目的历史，也不包含个人机器、真实凭证或运行数据。

## 系统边界

zen-gateway 是本机单用户 HTTP 网关。请求经过 Relay Token 鉴权、原始体读取、免费模型判定、协议能力判定、Worker 选择、上游尝试和流式透传，再经配置的直连出口或本机 Clash 出口访问 OpenCode Zen。

网关不提供多用户账户系统、公网远程管理、provider 抽象、静态网站托管或部署编排。上游地址、免费规则、Worker、出口和运行参数由配置文件决定。

## 模块

- shared：schema.ts 是配置唯一契约，contract.ts 是 HTTP 契约，redact.ts 集中处理脱敏，ip.ts 提供浏览器可移植的 IP 解析，batchProbe.ts 是批量探测 reducer，openCodeConfig.ts 是 opencode.json 形状（服务端写文件与后台片段共用）。
- core/protocols：注册 chat、responses、messages 三个协议面，负责路径、会话键、流式意图、协议专属请求头和 usage 形状。
- core/models：免费判定、keyed/keyless 目录缓存、token usage 解析。
- core/routing：WorkerPool、Scheduler、稳定选择、分级冷却、会话和推理指纹亲和。
- core/upstream：请求头、undici fetch、重试、流式透传和旁路扫描。
- core/proxy：dispatcher 池、Clash Controller、selector 锁、出口探测、订阅解析和导入；clash/setupImport.ts 是 Controller 发现与合并（setup 与管理面共用），clash/diagnose.ts 是 Clash 层诊断（doctor 与管理面共用）。
- server：启动装配、Hono 路由、Relay/loopback 守卫、配置补丁（patch.ts 与 patchSections.ts）、管理投影、批量探测执行、进程内诊断和 opencode.json 读写；routes/admin/ 下按功能拆分 clash、diagnostics、opencode 等管理路由。
- store：配置读写、端口解析、SQLite 迁移、统计和亲和持久化。
- admin：React/Vite 管理后台，构建产物由网关进程在独立端口伺服（server/adminSite.ts；设了局域网口令时监听 0.0.0.0），包括快速开始、概览、Worker、出口、客户端接入、网关、模型、用量和诊断页。

shared 不能导入 node:*，因为它会被浏览器构建。Node 专属能力只放在 server、store 和运行时 core 模块。

## 启动、热更新和关闭

server/index.ts 先加载严格校验的 config.json，再尝试打开 SQLite，随后创建唯一的 EgressService、Scheduler 和 ModelCatalog，恢复亲和与批量探测状态，组装路由并监听 loopback。已创建的 store 会把写入失败累计到 /health 的 storeWriteFailures；数据库在启动时打不开则停用统计、亲和持久化和批量探测并记录日志，转发仍可用，这种情况不计入该计数（排查方式见 [usage.md](usage.md#日志和数据库)）。

首次启动（本次新建了 config.json）且项目根没有 opencode.json 时，监听后异步生成它；项目根取服务工作目录（ZG_PROJECT_ROOT 可覆盖，供测试），与 ZG_DATA_DIR 无关。新建用临时文件加 link 独占落位，文件在检查后被别人创建时不会被覆盖。

启动监听后异步预热目录。预热失败不阻止服务；模型路由会报告“从未成功取得目录”的上游不可达。

SIGTERM/SIGINT 触发优雅关闭：先停止 HTTP server 接收新连接，在有界时间内排空在途请求，再关闭出口连接池和数据库后退出；排空上限 5 秒（`SHUTDOWN_DRAIN_MS`），超时强制断开。

PATCH /api/config 先原子写盘再替换进程内配置。并发写入串行化，并可用 expected 引用检测过期快照。配置变化会重置 Controller、dispatcher 和超时相关缓存，避免继续使用旧地址、旧凭证或旧连接。例外是 gateway.port：只写盘，监听端口在 npm run restart 后才换；启停脚本与 doctor 按状态文件（zen-gateway.state.json）记录的端口找到运行中的实例（scripts/lib/instance.mjs）。

npm start 和 npm restart 先构建，再由 scripts/service.mjs 管理服务。网关端口提供 /health、/v1/*、协议无前缀别名和 /api/*，不伺服页面；同一进程在独立的后台端口伺服 dist/admin，只把 /health 和 /api 交给网关。页面（index.html 与页面路由回退）带 `Cache-Control: no-cache`，升级重启后浏览器会重新确认并拿到引用新资源名的页面；`/assets/` 下带内容哈希的文件长期缓存，不存在的资源返回 404，不回退成页面。npm run dev 是开发用 Vite，同样只代理 /health 和 /api。运行方式见 [usage.md](usage.md#安装和运行)。

## 协议面与转发链

当前协议面如下：

| 面 | 客户端路径 | 上游路径 | 专属规则 |
|---|---|---|---|
| chat | /v1/chat/completions、/chat/completions | /chat/completions | 会话亲和使用 x-opencode-session |
| responses | /v1/responses、/responses | /responses | previous_response_id 可作为体内会话键 |
| messages | /v1/messages、/messages | /messages | Worker key 镜像到 x-api-key，并设置协议版本头；客户端可用 x-api-key 携带 Relay Token |

新增协议面只需实现 ProtocolSurface 并在 buildRegistry() 注册。路径、鉴权守卫和启动期覆盖检查均由同一注册表推导，避免出现新增路由未鉴权。

relay.ts 固定按以下顺序运行：

1. readBoundedBody 边读边读取原始字节，转发上限 64 MiB。
2. 解析副本，提取模型、流式标志、会话键和推理指纹；原始字节不经 JSON 往返。
3. 按（freeSuffix 命中 ∪ extraFreeIds）∩ 在架目录判定免费模型。
4. 检查协议面流式能力。
5. Scheduler.plan 生成有序 Worker 候选链。
6. runRetryChain 只看状态码和响应头，不消费响应体。
7. pipeUpstreamResponse 原样流式透传，并通过 tap 结算流状态、失效推理和 usage。

超限、空体、非法 JSON、付费/下架模型、流式能力不符和无可用 Worker 都在上游请求前拒绝，并记入 gateway_rejections。Relay Token 永不转发；上游请求头由 Worker key 和协议面规则重建，凭证头、逐跳头和客户端 forwarded 头会被剥离。

## 重试、流和失败分类

响应头到达前的传输失败可以换 Worker；中间响应体必须取消；最后一次 body 保留给客户端。400/422 等请求错误不归咎 Worker、不重试、不冷却。出口配置错误单独标记，避免误报成上游故障。状态确定并开始写出后，后续断流不再重试。

tap 使用手写 ReadableStream 保持原字节和时序，使用流式 UTF-8 解码和按最长模式推导的重叠窗口。完整成功流才学习推理指纹；失效推理解绑并遗忘；断流或客户端取消不学习也不盲目遗忘。谁锁住 body，谁负责失败路径上的释放。

失败分类由状态码、响应头和本地异常决定，不读取错误 body。rate_limit 尊重 Retry-After 并长冷却；auth（401/402/404）固定短退避；forbidden（403）更短的固定冷却并换 Worker 重试，因为免费闸门按请求形态、地区限制按出口返回 403，换出口可能成功；transport、timeout、upstream_error 指数退避并抖动；bad_request、unknown 不冷却。冷却只延长不缩短；并发成功只有在尝试开始时间晚于冷却时才清除现有冷却。目录尚未核验的模型收到 401 时不归咎 Worker，因为不存在的模型也返回 401。

## 目录与调度

ModelCatalog 为 keyed 和 keyless 保存最后成功目录。响应必须非空、结构正确并通过条目数和 8 MiB 体积上限；失败刷新不会抹掉旧缓存；刷新失败后的退避同时作用于 /v1/models 的 ensure 路径和转发路径的 refreshIfStale。转发路径通常只读缓存，判定为 `retired` 且缓存过期时会发起后台刷新，但不会等待它完成或把目录请求加入重试链。目录缺失时免费判定按配置规则放行并标记未核验；/v1/models 在从未成功取得目录时返回 502 upstream_unreachable，目录取得但免费集合为空时才返回成功空列表。

模型页的协议列不是放行闸门，放行能力由 ProtocolSurface.streaming 决定。声明由 core/models/protocols.ts 的 ProtocolDeclarations 从 models.dev 拉取：只保留 `opencode` 下 id → AI SDK 包名映射出的协议，边读边限 32 MiB、20 秒超时、并发合流，成功缓存 6 小时，失败退避 5 分钟且保留旧缓存；启动后预热，/api/models 只读缓存并在过期时后台刷新。它不经 Worker 出口（不是发往 Zen 的请求，也不应占用 selector 锁），也不进入免费判定。实测来自 StatsStore.modelProtocols：upstream_attempts 中 2xx 的 (model, protocol)，默认近 30 天窗口。旧配置的 defaultSurfaces / surfaceOverrides 在 ConfigSchema 的 models 预处理里丢弃。

WorkerPool 是唯一持有 Worker 运行状态的组件。启用认证 Worker 必须有 key；匿名 Worker 经 WorkerSchema 归一化为空 key，按免 key 请求发送。匿名请求是否被上游接受属于上游策略。

候选顺序是就绪亲和命中、其他就绪 Worker 的稳定策略排序、全员冷却时最早恢复的一个。重试链实际承接者在 settled 后成为新的会话绑定。会话键和推理指纹只保存 SHA-256 摘要；过长会话键不截断而是不参与亲和；TTL 是滑动闲置时间。SQLite 只做写入镜像和启动恢复，关键请求路径不查同步数据库。

## 出口与回显报告

EgressService 统一管理 dispatcher、Clash Controller 和 selector 锁；转发与探测共享同一实例、池和锁。

- 直连 HTTP、HTTPS、SOCKS 使用支持 dispatch 的 undici 出口。
- 桥接模式切换 selector 后经本地代理端口连接。
- dispatcher 按代理 id 缓存，身份键包含桥接的 Clash 节点名（或直连的协议、地址、用户名与口令摘要）和超时；身份变化即重建。节点名必须在键里，否则 keep-alive 复用会让出口停在旧节点。
- Controller 缓存指纹含地址和凭证摘要，等长 secret 改变也会重建。
- selector 切换和建连在同一把锁内，连接建立后即释放锁。

回显报告按 IP 回显目标的实测公网 IP 分组；未知 IP 不计为独立。直连出口保存到 gateway.directEgressIp，使用专用合成 id。doctor 第 5 层读取 /rules 检查选中分组是否参与规则、是否是 MATCH 目标，并用内核 DNS 解析上游域名、按规则顺序找出首条命中（upstreamRoute），不经过所选分组时告警；doctor --deep 以回显 IP 做分组核对。回显结果与 Zen 实际出口的关系见 [回显 IP 的测量范围](usage.md#回显-ip-的测量范围)。

Clash 支持 manual 和 auto。转发路径由 pickBridge 按配置取内核、不探活：manual 严格用 activeBridgeId；auto 优先 activeBridgeId，否则按 priority 和 id。探活择优（selectBridge：可连通、分组内有节点、粘滞、priority、id）只在批量探测第 0 段执行，并把结果写回 activeBridgeId；批量探测期间锁定该内核。doctor 也运行同一择优但只读。

## 管理 API 与后台

管理 API 只接受 loopback TCP 对端地址，不信任 X-Forwarded-For。局域网访问不改变这一点：管理后台页面（server/adminSite.ts，与网关同进程、独立端口）把非回环对端的请求换成回环地址并打上 `LAN_PEER` 标记后交给网关 app；带标记的请求一律按局域网处理（Host 写成回环也无效），且 Host 须为私网 IP 字面量、Origin 同源，loopbackOnly 要求 LanAccess（server/admin/lanAccess.ts）签发的会话 cookie；口令以 scrypt 哈希存于 `gateway.lanPasswordHash`，会话在进程内存中并绑定签发时的哈希，改口令即失效；只有本机请求能改口令。管理体上限 1 MiB，转发体上限 64 MiB，均边读边限。端点清单见 [usage.md 的管理 API](usage.md#管理-api)。

凭证投影只返回存在性和短指纹。secret 补丁是缺席不动、set 替换、clear 清空三态；Relay Token 另有 rotate，由服务端用首启同一个生成器生成。响应返回前再次过契约 schema。

补丁合并顺序为 gateway → routing → models → workers → clash → subscriptions → proxies：Worker 先改绑，之后再删除其原代理是合法的；删除内核或订阅连带删除其导入的代理，其中仍被引用的则整个请求失败。全部合并完成后再过一次全量 ConfigSchema。

Clash 发现与导入和 setup 共用 setupImport.ts；导入经 applyConfig 热更新，合并基于发现完成后重读的配置。进程内诊断（server/admin/diagnostics.ts）与 doctor 共用 Worker 和 Clash 层实现，目录层走 /v1/models 同一条 ensureCatalog 路径并报告服务进程自身的 NODE_EXTRA_CA_CERTS；各层独立运行，不在首个失败处停止。/api/probe 经 BatchProbeRunner.runExclusive 与批量探测共享同一把互斥锁，避免同时切换 selector；它可用 proxyIds 只探指定出口，后台据此逐个探测以显示进度。

批量探测由 reducer、SQLite 状态和 BatchProbeRunner 组成，状态为 idle、screening、running、paused、cancelling、done；范围是全部已启用节点加在用的本机直连（batchTargets）；两段进度分开显示，逐个节点的状态只保存在进程内存里（结果已写回配置，重启不需要恢复）；同一时刻只允许一批运行，进程重启会收尾遗留任务。createWorkers 为真时，结束后为可用、未被引用且回显 IP 不重复的节点一次写盘建匿名 Worker，命名与后台批量导入共用 shared/workerIds.ts。前端轮询以服务端状态为准，并用 generation 防止旧响应覆盖取消后的状态；轮询失败时保留上次数据并提示可能过期。

订阅支持 Clash YAML/JSON、SIP008、分享链和多层 Base64。多 User-Agent 协商、纯函数解析和幂等合并共同构成刷新流程；节点 id 由订阅 id 和节点名派生，并保留启用状态与已测出口 IP。

## 持久化

config.json 保存网关、模型规则、Worker、代理、订阅和 Clash 配置。目录权限 0700，文件权限 0600；写入使用临时文件、fsync 和 rename。schema 使用严格对象并检查 Worker→proxy、proxy→bridge 等引用。

runtime.db 使用 SQLite WAL，保存 worker_stats、model_usage、session_usage、upstream_attempts、gateway_rejections、probe_results、session_affinity、blob_affinity 和 batch_probe_jobs。带 `x-opencode-session` 的请求 token 写 session_usage（按会话摘要与模型只留最大的一条），model_usage 只记它们的请求计数；聚合时两表合并。统计和诊断写入失败不阻断转发，但会计入健康信息。明细表启动时按保留期清理，并启用 secure delete。

## 安全与验证边界

错误消息和日志中的客户端可控文本经过脱敏、长度和字符限制；凭证只在必要的内部请求处使用。服务进程使用 Node 的 TLS 信任库；企业中间人环境可能需要 NODE_EXTRA_CA_CERTS。curl 的系统 CA、代理环境、DNS 和请求形态可能与 Node 或真实 OpenCode CLI 不同，因此 curl 只能验证局部链路，不能替代真实客户端端到端验收。

shared 不导入 node:*。本地完整关卡是 typecheck、双构建和全部测试串成的 npm run validate；需要网络的 npm run discover:upstream 不纳入该关卡。完成范围与未实现项见 [需求文档](requirements.md#12-当前已完成范围)。
