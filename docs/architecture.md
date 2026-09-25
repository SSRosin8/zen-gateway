# 架构

## 一句话

客户端（OpenCode）→ 本网关（鉴权 → 免费判定 → 选 Worker → 重试链 → 流式透传）→ OpenCode Zen，
每个 Worker 经**各自独立的公网出口**发出。

---

## 目录划分

```
src/
├── shared/      # 三端唯一契约 —— 必须浏览器可移植（admin 会打包它）
│   ├── schema.ts    zod schema + 推导类型 + 引用完整性
│   ├── contract.ts  /health、poolHealth、管理 API 的读写契约
│   ├── redact.ts    脱敏的单点定义
│   └── ip.ts        IP 校验（WHATWG URL 实现，不用 node:net —— 见下）
├── core/
│   ├── failures.ts      失败分类：仅依据 status + headers，绝不看 body
│   ├── protocols/       协议面注册表（types / registry / chat / responses / messages）
│   ├── models/
│   │   ├── free.ts      免费判定：(后缀 ∪ 名单) ∩ 在架目录
│   │   ├── catalog.ts   在架目录缓存（两个身份槽位，校验过的最后成功缓存）
│   │   └── usage.ts     token 用量：字段归一化 + 跨 SSE 事件合并
│   ├── routing/         调度状态机（Phase 5）
│   │   ├── workerPool.ts  Worker 集合与就绪判定（唯一持可变状态的一块）
│   │   ├── cooldown.ts    分级冷却（纯函数，注入时钟与抖动）
│   │   ├── affinity.ts    会话／推理指纹 → Worker，只存 sha256 摘要
│   │   ├── select.ts      候选链排序：粘滞 → 策略 → 全员冷却
│   │   └── scheduler.ts   四块的组合层，进程内唯一
│   ├── upstream/        fetch / retry / pipe / tap / headers / url
│   └── proxy/           pool / dispatcher / probe / selectorLock / egress / clash
├── server/
│   ├── index.ts app.ts
│   ├── middleware/      relayAuth / loopbackOnly / errorMap
│   ├── admin/           管理面的投影与补丁合并（project / patch）
│   └── routes/          relay / models / admin
├── store/
│   ├── paths.ts     data/ 与 config.json 的位置（轻量层，无第三方依赖）
│   ├── port.ts      端口解析的唯一真相
│   ├── config.ts    加载/校验/版本闸门/0600 原子写
│   └── db/          sqlite schema + 迁移执行器
└── admin/           React SPA（Overview 页已交付，其余 5 页在 Phase 9 批次 2）
```

### 三条不能改的结构约束

**`src/shared/` 不得 import `node:*`。** 它被管理后台的 Vite 构建打包，
任何 Node 内置模块都会让构建直接失败。所以 IP 校验在 `shared/ip.ts` 用
WHATWG `URL` 的 host 解析器实现，而 `node:net.isIP` 只在**测试里**当权威基准
做模糊对照（4 万次，零分歧）。

**端口只有一处解析。** `store/port.ts` 是唯一真相，三个调用点
（`server/index.ts`、`scripts/service.mjs`、`vite.config.ts`）都从它取值。
先前三处各自手写，Phase 3 因前两处脱节炸过一次，而第三处（vite 代理）
一直硬编码着 9876 —— 症状是 dev 下 `/health` 被转发到**另一个进程**，
看起来在工作但数据来自错误后端。现有测试同时用行为断言与**结构断言**
（三个文件的代码里不得出现端口字面量）守着。

**`store/paths.ts` 与 `store/config.ts` 分层。** 脚本与 vite 需要知道
config.json 在哪，但不需要解析配置。合在一起会让它们连带拖入 zod 与整个
schema：实测 +57ms，而 `service.mjs status` 全程只有 51ms。

---

## 请求流程（转发面）

`server/routes/relay.ts`，七步，顺序不可调换：

| # | 步骤 | 为什么在这个位置 |
|---|---|---|
| 1 | 读**原始字节**（只读一次） | 转发出去的必须是客户端的原始字节 |
| 2 | 解析一份**副本**做判定 | `JSON.parse`→`stringify` 往返**不是无损的**（`{"n":1.0}` → `{"n":1}`） |
| 3 | 免费判定 | 放行付费模型的代价是真金白银，且请求发出无法收回 |
| 4 | 流式能力校验 | 面声明 `streaming: "none"` 时拒绝流式请求 |
| 5 | 选 Worker（调度状态机） | 粘滞／冷却在这里收口，见下节 |
| 6 | 重试链 | 只看 status + headers，**body 不消费**；逐次回调记冷却 |
| 7 | 流式透传（带旁路结算钩子） | **唯一**写出客户端字节的地方 |

第 3、4 步都判定"请求本身"的问题，在本机就能定论，不该花一次上游调用去换
一个已知的答案。

---

## 调度状态机（Phase 5）

`core/routing/`。四块纯函数／纯数据结构 + 一个组合层，状态集中在
`workerPool` 一处 —— 这样"为什么这次选了它"可以由一次 `snapshot()` 完整回答。
旧项目是一个 432 行带隐式状态的 class，那个问题答不了。

### 候选链的排序规则

`select()` 返回一条**有序候选链**而不是单个 Worker：返回单个的话，
"这次请求会依次试哪些 Worker"在代码里没有答案。

1. **粘滞命中且就绪**的 Worker —— 严格粘滞，不被策略抢占
2. 其余**就绪**的，按 `routing.strategy` 排序（稳定排序，同类别保持配置顺序）
3. 一个都不就绪时：只给**最早恢复**的那一个

第 3 条不是轮转槽位，也不是"把冷却中的排进尾巴"。两者都错：轮转会在全员冷却时
散到恢复最晚的那个，让重试互相错过；排进尾巴等于"有健康 Worker 时也可能打到
冷却中的"，而冷却存在的理由正是别再打它 —— 429 尤其，上游刚说了
`Retry-After: 900`，2 秒后再发一次只会换来更长的封禁。

### 分级冷却

| 类别 | 处置 | 为什么 |
|---|---|---|
| `rate_limit` | 尊重 `Retry-After`，否则 15 分钟；**有地板** | `Retry-After: 0`（或已过期的日期）会让 Worker 立刻重新就绪 |
| `auth` | **固定**短退避 60 秒，不随次数增长 | 指数递增会让"key 配错了"逐渐变成"网关有点慢"，抹掉短退避的理由 |
| `transport`/`timeout`/`upstream_error` | 指数退避 + **比例式**抖动（25%） | 固定毫秒抖动对 2 秒退避是 ±50%，对 120 秒等于没有 |
| `bad_request`/`unknown` | **不冷却** | 不变量 #4：一次坏请求不该打掉所有健康 Worker |

冷却**只延长不缩短**（取 `Math.max`）：并发失败乱序到达时，一次传输失败的
2 秒不能覆盖 429 的 15 分钟。

### 会话亲和

两条依据，都只存 **sha256 摘要**：会话键（`x-opencode-session`，或 Responses 面
体内的会话指针）、加密推理指纹（`encrypted_content` / `signature`）。
`runtime.db` 两张表的 `CHECK`（档位 2）同时限定**字符长度、字节长度与字符集**。

> 三个条件缺一不可。档位 1 只查字符长度与字符集，而 SQLite 的 `length()` 与
> `GLOB` 对 TEXT 都在首个 NUL 处停止 —— 第七轮审核实测「64 个 hex + NUL +
> 任意明文」完整通过校验并落盘，而所有读路径在 NUL 处截断看不见它。
> 补 `length(CAST(hash AS BLOB)) = 64` 才真正收口。
>
> 安全性的**第一道**防线仍是 `digestOf()`（生产路径每个键都过它）；
> CHECK 是第二道，防的是将来新增的写入路径漏掉 digest。

**TTL 是滑动的** —— 每次选择刷新绑定时间，度量的是**闲置**时长。固定 TTL 会在
一条正在进行的长对话中途强制换 Worker，而那恰好是粘滞要避免的事。

**绑定在选择时落下**，不等成功：同一会话的并发请求要落到同一个 Worker。
链 settled 后还要 `rebind()` 到**实际**承接者 —— `plan` 绑的是候选链首位，而
「w1 拿到 429 → w2 成功」这条链里签发推理块的是 w2。不改绑的话 w1 冷却结束后
下一轮回到它，客户端回放的推理块必被拒。**这个缺陷是集成测试查出来的**：
单测结构上测不到，它模拟的是"冷却发生在 plan 之前"。

**指纹提示要求全体一致**：所有指纹指向同一个 Worker 才给提示。指向不同说明
请求混合了两个来源的推理，无论选谁都会被拒 —— 此时提示一个比不提示更糟，
它会抢在策略排序之前把请求钉到必败的那个。

### 不变量 #3 的结算钩子

`upstream/tap.ts`。SSE 可以带着 HTTP 200 把「你回放的推理块不是签给你的」
塞在流里面，只看状态码整条漏掉。但本项目原样透传，不能先读完再转发 ——
那会让长 SSE 在网关里憋到结束。

所以做**旁路中转**：字节原样往下游走，同时复制一份解码文本交给扫描器。
返回的流与入参逐字节相同，时序也不变。

这不违反不变量 #1：本模块不做任何重试决定，回调只在流**彻底结束之后**触发，
那时响应早已完整发出，重试已不可能。

三条实现约束，每条对应一个会静默失败的坑：

- **用手写 `ReadableStream` 而不是 `TransformStream`**：后者在上游出错时不调用
  `flush()`，于是"流异常结束"拿不到通知 —— 而那正是最需要区分的结局
  （内容不完整，不能据此学习绑定）。
- **解码必须 `{ stream: true }`**：UTF-8 多字节序列会跨块切断，一次性解码在边界
  产出替换字符，而那可能正好落在要匹配的消息中间。
- **跨块扫描要带重叠窗口**：拒绝消息可能被切在两块之间，逐块独立匹配会漏，
  而漏掉的症状取决于上游的分块位置 —— 时有时无，极难复现。

结算的三种结局：检出失效推理 → 解绑 + 忘掉指纹；2xx 且**完整读完** → 学习指纹；
**不完整**（断流／客户端按 ESC）→ 什么都不做。第三条是关键：学了可能把一个其实
会拒的 Worker 记成正确答案，忘了则白丢一个可能正确的绑定。

### 与 `/v1/models` 刻意不共享状态

目录查询走 `usableTargets()`，不经调度器。让一次目录查询失败把 Worker 打进冷却，
等于**一个只读查询改变了转发的候选顺序**，而用户看不出这两件事有关系。

---

### 协议面注册表

新增一个客户端协议 = 加一个文件 + 在 `app.ts` 的 `buildRegistry()` 加一行。
路由由 `registry.paths()` **动态挂载**，路由层没有任何面 id 的字面量；
鉴权守卫的挂载点也从同一个注册表推导，所以加一个面自动多一道守卫。

**Phase 6 兑现了这个验收条件**：加 `responses` 与 `messages` 时，`src/server/`
下唯一的改动是 `buildRegistry()` 里那两行 `.register(...)`。路由装配、鉴权、
调度、重试、透传都一行未改。三个面共六条路径（各含无前缀别名）。

> 对比第四轮审核：那时守卫是手写的三条路径字面量，按当时注释承诺的 Phase 6
> 形态注册两个面之后，`/responses` 与 `/messages` 两条无前缀别名**完全绕过鉴权**。
> 现在这条从"假想"变成了对真实装配的回归守卫（`tests/integration/phase6.test.ts`）。

接口**全部是只读判定**，在解析副本上做。规划里曾设计 `transformRequest`
改写请求体，实际去掉了：三个面在 Zen 各有原生端点（同形状换路径），
而改写需要 JSON 往返，与"原样透传"冲突。

三个面各自带来的新东西不在装配层：

| 面 | 独有的事 |
|---|---|
| `chat` | 无体内会话标识，亲和只能靠 `x-opencode-session` |
| `responses` | `previous_response_id` 是**体内**会话指针，优先于头 |
| `messages` | 必须把 key 镜像到 `x-api-key`（否则上游 500），并发 `anthropic-version` |

`messages` 那条是本阶段实测出来的，且失败方式最糟：只给 Bearer 时上游返回 500，
归 `upstream_error` → 可重试且**归咎 Worker** → 客户端一用 Messages 面就把
整池 Worker 打进冷却。详见 `upstream-quirks.md` §8。

`parseUsage` 在 Phase 6 一并落地（规划列了它，而先前全仓不存在）。它的**生产
调用点**在 `relay.ts` 的流末尾结算钩子里，与失效推理扫描共用同一个 `onText`。
刻意不等到 Phase 7 才接：一个只有接口与实现、没有调用点的成员，就是第四轮那个
`streaming` 字段的形态 —— 声明了却不设防。

---

### 免费判定与在架目录

完整判定是 **（后缀命中 ∪ `extraFreeIds`）∩ 在架目录**。交集是已下架 id
自动失效的**唯一**机制：`glm-5-free` 后缀命中，少了交集就会被放行，
再由上游返回 400 `Model is unavailable.` —— 用户看到的是上游措辞，
指不到"这个 id 已经下架了"。

**不对称要说清**：交集能自动剔除下架的，但**新出现的无后缀免费模型无法自动
发现** —— `/zen/v1/models` 给在架性却**不给价格**。所以新的零费率无后缀模型
只能人工补进 `extraFreeIds`（`big-pickle` 就是这么来的）。

目录缓存（`core/models/catalog.ts`）三条性质：

- **校验过的最后成功缓存**：空 `data`、缺 `data`、条目数离谱的响应**一律不采纳**。
  采纳一份空目录会让免费集清空 → 网关拒绝一切，比拉取失败更糟。
- **旧的永不硬过期**：拉不到就继续用旧的。一份三天前的目录远好于"网关不可用"。
- **两个身份槽位**（带 key／免 key），不是 per-Worker 的 N 个。依据见
  `upstream-quirks.md` §7 —— 注意那条结论被修正过两次，现在站得住的版本比
  "目录按身份区分"**更窄**：整份目录确实按账号不同，但**免费子集三账号一致**。

**目录缺失时放行而不是拒绝**，与"默认拒绝"不冲突：默认拒绝针对"判定不出免费"
（放行代价是真金白银），而目录缺失时免费依据仍成立，缺的只是"是否还在架"，
而那唯一的后果是上游拒绝，不产生费用。反过来做的话，一次上游抖动就会让网关
拒绝一切。

刷新时机：**启动预热** + `/v1/models` 被访问时。转发路径**只读缓存，不发请求**
（唯一例外是判出"已下架"时刷一次 —— 那是过期目录唯一能造成实际伤害的情形）。

> 我第一版在每个转发请求上刷目录，结果一次客户端请求变成两次上游请求，
> 且拉取失败不填缓存 → 下个请求又发 → 稳态永久 ×2。13 条既有集成测试
> 一起报红查出来的，纯单测看不见"一次请求发了几次上游"。

---

## 出口隔离（这个项目存在的理由）

`core/proxy/`。两种出口：**直连**（http/https/socks4/socks5，走 undici dispatcher）
与**桥接**（其余协议经本机 Clash，由 Controller API 切 selector）。

三条只能靠实测得到的结论，每条都对应一个曾经真实存在的 bug：

**必须从 `undici` 导入 `fetch`，不能用全局 fetch。** `dispatcher` 是 undici
特有选项，全局 fetch 会**静默忽略**它 —— 于是所有请求走本机默认出口，
出口隔离整体失效且毫无报错。

**SOCKS 出口必须用 `fetch-socks`。** `socks-proxy-agent` 是 `http.Agent`，
没有 `dispatch()`，undici 的 fetch 用不了（实测 `instanceof Dispatcher === false`）。

**桥接 dispatcher 必须按 Clash 节点名缓存。** Clash 在**建立连接时**绑定出站
节点，而 undici 会复用 keep-alive 连接。按 Worker 或 proxy id 缓存会让
`select()` 形同虚设 —— 实测同一 proxy 依次指向 A→B→B，三次探测全报 A 的 IP，
服务端只看到 1 条 TCP 连接。而探测结果会被持久化进 `egressIp`，
出口隔离报告正是按它分组，整份结论建立在错误数据上。

转发与探测还必须共用**同一个** `DispatcherPool` 与同一套锁
（`EgressService.upstreamDeps()`）：Clash selector 的 `now` 是**进程外全局状态**，
两套锁会让探测量到的 IP 不是转发实际用的那个。

### 隔离判定按实测 IP，不按 proxyId

`buildIsolationReport` 以规范化后的 `egressIp` 为分组键。按 proxyId 判断是
旧项目的做法，而两个不同代理可能 NAT 到同一个公网 IP —— 那种情况下报告说
"已隔离"而实际没有。

未探测出 IP 的记录归入 `unknownWorkerIds`，**不算已隔离**：
"还不知道"和"确认不同"是两件事，混在一起会给出虚假的安全感。

> **一个已知的结构性缺陷**：探测打的是 IP 回显服务（`api.ipify.org` 等），
> 而转发打的是上游 host。两者可能命中**不同的 Clash 规则分支**，于是
> 探测结论与实际转发出口无关。真实踩到过：某机器的内网 DNS 把上游解析到
> 私有地址，转发命中 `IPCIDR 10.0.0.0/8 → DIRECT` 走了直连，而探测走代理。
> **探测目标必须与转发目标同域**，待修。

---

## 七条控制流不变量

前六条是读旧项目代码核实过的正确性不变量，第 7 条由 Phase 2 的独立审核发现。
它们不作为移植测试，而是各阶段的显式设计需求，并在该阶段自建断言。
**七条现已全部落地。**

| # | 不变量 | 状态 |
|---|---|---|
| 1 | **重试链与流式泵分层**：`retry.ts` 只依据 status+headers，返回 body **未被消费**；字节写出全部在 `pipe.ts`，且在重试链彻底结束之后 | ✅ |
| 2 | **body 取消的非对称**：非最后一次尝试必须 `cancel()`（否则连接泄漏）；**最后一次必须保留** body（让客户端看到上游真实错误） | ✅ |
| 3 | **流结束后的亲和结算**：SSE 可以带着 200 返回"推理已失效"，必须有结算钩子解绑 | ✅（`upstream/tap.ts` + `Scheduler.settleStream`） |
| 4 | **不可重试的 4xx 要记成功**：400/422 是请求本身的问题，不归咎 Worker —— 否则一次坏请求能把所有健康 Worker 逐个打进冷却 | ✅ |
| 5 | **Clash selector 锁的范围**：切换 + 建连必须原子，但锁要在 body 开始流**之前**释放（否则一条长 SSE 串行化整个网关）。注意 Promise 同化：任务只能返回**响应对象** | ✅ |
| 6 | **headers 超时与 body 空闲超时必须分开**：单一 `AbortSignal.timeout` 会把正常的长 SSE 到点掐断 | ✅ |
| 7 | **桥接 dispatcher 按节点缓存**，且转发与探测共用同一个池与锁 | ✅ |

破坏第 1 条的症状是同一个：已经给客户端发了 200 和一部分 SSE，然后又去重试，
客户端收到两段拼接的响应 —— 表现为 JSON 解析失败或对话内容莫名重复，
极难归因到网关。

---

## 存储

| 载体 | 内容 | 理由 |
|---|---|---|
| `data/config.json`（0600 原子写） | 凭证、Worker、代理池、订阅、桥接、网关设置、模型规则 | 可手工编辑/备份/审阅；无 UI 阶段直接编辑它 |
| `data/runtime.db`（SQLite WAL） | 见下表 | 高频写 + 需聚合查询 |

已建的 7 张表（Phase 1 建好结构，Phase 7 才填数据）：
`worker_stats`、`model_usage`、`upstream_attempts`、`probe_results`、
`session_affinity`、`blob_affinity`、`batch_probe_jobs`。

两处把约定变成结构约束：

- **引用完整性做进 schema 的 `superRefine`**，而不是运行期检查。指向已删除代理的
  Worker 会静默退回本机直连出口，于是与其他 Worker 共用同一个公网 IP ——
  这种失败必须在**加载配置时**暴露，不能等到上游因同 IP 多账号封号。
- **全部用 `strictObject`**：手工编辑是预期用法，拼错字段名必须立刻报错，
  而不是静默忽略后让人困惑"我明明改了"。

---

## 实现进度

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 脚手架、四份 tsconfig、设计 token、对比度构建期断言、`service.mjs` | ✅ |
| 1 | schema、config 存取、sqlite schema + 迁移 | ✅ |
| 2 | 出口链路：pool / dispatcher / Clash Controller / 探测 | ✅ |
| 3 | 转发骨架 + 协议注册表 + 鉴权 + 错误映射 | ✅ |
| 4 | 上游协议发现（范围按实测缩减，见 `upstream-quirks.md`） | ✅ |
| 5 | 调度状态机：`workerPool` / `cooldown` / `affinity` / `select` / `scheduler` | ✅ |
| 6 | 其余协议面（`responses`/`messages`）+ 免费注册表与在架目录求交集 + `parseUsage` | ✅ |
| 7 | 统计 SQL 聚合 + 亲和持久化 | ✅（**无 HTTP 端点** —— 管理 API 形状留给 Phase 9） |
| 8 | `setup.mjs`（一键配置）、`doctor.mjs`（分层诊断）、`service.mjs` 打开浏览器 | ✅ |
| 9 | 管理后台 6 页 + 首启向导 + 批量探测长任务状态机 | 🟡 批次 1 已交付（管理 API + Overview 页）；其余 5 页与向导待做 |
| 10 | 订阅拉取与多格式解析、多 Clash 内核择优 | 待做 |
| 11 | 精简 `AGENTS.md`、4 个 skill、`docs/` 补全 | 部分 |

经**七轮**独立子 agent 审核（一轮审规划 + 六轮审代码/文档）。

> 规模数字（测试条数、文件数、代码行数）刻意不写在文档里 —— 它们每次提交
> 都变，而第七轮审核发现这里的五个数字全部过期（测试数差 62、源码行差 1176）。
> 要当前值就跑 `npm run validate`，或 `find src -name '*.ts*' | xargs wc -l`。

### 管理面的投影层（Phase 9 批次 1）

`server/admin/project.ts` 是**唯一**允许读凭证字段的地方，且它只输出
`SecretPresence`（`{present, fingerprint}`）。窄化集中在一处而不是散落在各个
handler 里 —— 散落的后果可预见：新增端点时漏掉一个字段，而那个漏洞**没有
任何症状**（响应照常返回，只是多带了一个 key）。

**用 sha256 前 8 位而不是长度**：等长的两个 key 长度相同，于是「我改了没生效」
在界面上不可见 —— 而那恰好是修密码最常见的形态（把打错的换成同长度的对的）。
刻意**不复用** `core/proxy/credentialFingerprint.ts`：那是安全边界（决定
dispatcher/Controller 是否重建，取值范围由「碰撞会导致复用旧凭证」决定），
这里是展示用途（必须短到能显示）。共用会让一方的约束变化悄悄影响另一方。

写入方向的凭证是**三态**（`{set}` / `{clear:true}` / 缺席不动）：前端拿不到
原值，所以不能靠「回传原值」表达「不动它」，而 `apiKey?: string` 会让一个未填的
输入框静默抹掉能用的 key。

### 当前已知缺口

1. ~~**配置热更新只有形状没有入口**~~ —— **Phase 9 批次 1 已解决**。`PATCH /api/config`
   → 纯函数合并（`server/admin/patch.ts`，含全量 `ConfigSchema` 与引用完整性）
   → `saveConfig` 原子写 → 换进程内引用。顺序是**先写盘再换引用**（反过来会留下
   「内存已生效而磁盘是旧值」的半生效状态），且必须换**新对象**（`Scheduler.#syncedFrom`
   用引用比较）。生产验证：停用一个 Worker，池 3→2→3，无需重启。
   顺带给了 `egress.reset()` 第一个生产调用点
2. ~~**亲和只在内存里**~~ —— **Phase 7 已解决**。`AffinityMap` 接了一个
   `AffinitySink`，每次内存变更（绑定/解绑/学习/遗忘/容量淘汰/prune）都镜像落盘，
   启动时按 `bound_at` 升序装回。**查询路径仍然零 DB 读** —— `node:sqlite` 是
   同步 API，把亲和查询换成查库等于在每请求的关键路径上阻塞事件循环。
   代价是 `kill -9` 可能丢最后一刻的绑定（后果是那条会话重挑一次 Worker）
3. ~~**用量只进日志，没有聚合**~~ / ~~**尚无 HTTP 端点**~~ —— **均已解决**。
   Phase 7 给了 `store/db/stats.ts`，Phase 9 批次 1 给了 `GET /api/stats`
   （默认带 `sinceDay`，见缺口 #14）。Usage **页面**在批次 2
4. **探测目标与转发目标不同域**（见上文出口隔离节）
5. **调度与目录状态没有查看入口**：`Scheduler.snapshot()` 与 `ModelCatalog.status()`
   都已实现且不含凭证，但**两者都没有生产调用点** —— `npm run status` 只报进程信息，
   也还没有管理 API 读它们。两处都已在源码里明确标注（照 `surfacesFor()` 的先例），
   免得下一轮把它们当成在用的接口。眼下只能从响应头 `x-zen-gateway-route`／
   `x-zen-gateway-worker`／`x-zen-gateway-free` 与 `/v1/models` 响应体里的
   `zen_gateway_catalog` 字段推断（→ Phase 8 的 `doctor.mjs` / Phase 9 的管理 API）
6. **目录的免费子集一致性没有本地守卫，也守不住**：两个槽位的设计依赖"免费子集
   三账号一致"（`upstream-quirks.md` §7），而那是**上游的**性质，单测无论怎么写都只是
   在断言自造的 fixture。复核办法是拿多个账号各拉一次目录比对免费子集。
   本地能守的是它不成立时的处置（多一个 → 上游 400 自限；少一个 → 触发刷新），那已有用例
7. **目录响应只限条目数，不限体积**：`MAX_CATALOG_ENTRIES` 的闸门在 `parseCatalog` 里，
   也就是 `upstream.json()` 已经把整个体读进内存之后 —— 实测一个单条目、40 MiB 的
   响应被照常采纳。不构成当前风险（本机自用、baseUrl 由 schema 限 http/https、
   调用频率受 TTL 与失败退避约束），注释已把范围收窄到它真正守住的那件事。
   若 Phase 7+ 把 baseUrl 做成更开放的配置项，要在 `json()` **之前**加体积闸门
8. ~~**`assertEveryRouteGuarded` 只检查"有没有守卫"，不检查"是哪个"**~~ ——
   **Phase 9 批次 1 已补** `assertAdminRoutesLoopbackOnly`：`/api/*` 下每条路由都必须被
   **回环闸门**覆盖。判据用中间件的**身份**（`loopbackOnly()` 带一个 Symbol 标记）
   而不是路径形状 —— 只比路径的话，「`/api/*` 上挂了某个中间件」并不能说明挂的是它。
   构造期抛错：服务起不来远好于管理面静默对外开放
9. ~~**管理面的 body 上限尚无处可设**~~ —— **Phase 9 批次 1 已加**（1 MiB，
   与 relay 的 64 MiB 刻意不同：后者为多模态留的，管理面没有那个需求）。
   `content-length` 与实读长度**两处都查** —— 头可以撒谎或缺席，
   而只在读完之后检查等于上限没起作用
10. **`models.defaultSurfaces` / `surfaceOverrides` 声明了但不设防**：`surfacesFor()`
   已实现且有单测，但**全仓没有生产调用点** —— 这与第四轮那个 `streaming` 字段
   是同一个形态（声明了却不读）。

   **但不能顺手"补上"**：默认值是 `["chat", "responses"]`，若按它放行，
   默认配置下**所有**模型的 `/v1/messages` 请求都会被拒 —— 而那个面刚刚验证可用。
   所以这里要先定清楚它的语义（是"放行闸门"还是"后台展示用的提示"），
   再决定默认值。眼下当作后备展示数据，不参与判定（→ Phase 9 的 Models 页）
11. ~~**「网关拒绝」这项规划要求没有实现**~~ —— **已补**（档位 3 的 `gateway_rejections`，七条拒绝路径全部记账，`not_free` 与 `retired` 分开）。原文：：Phase 7 的验收列了六项统计，
   前五项都有（Worker 计数 / per-model token / 缓存命中 / usage 覆盖率 /
   上游尝试日志），而**第六项「网关拒绝」没有表、没有列、没有写入点**
   （第七轮审核查出）。`relay.ts` 有 6 条在打上游之前就返回的路径
   （400 读体失败 / 413 超限 / 400 空体 / 400 非法 JSON / 403 免费闸门 /
   503 无可用 Worker），全部零记录 —— 403 那条连日志都不打。
   于是「我有多少请求被网关自己挡了」现在完全无法回答，而
   `not_free` 与 `retired` 的处置完全不同（前者改模型名、后者删
   `extraFreeIds` 条目），哪种发生得多也不可观测（→ Phase 8/9）
12. **仍有四个「实现了但没有生产读者」的成员**（`snapshot` / `status` / `surfacesFor` / `counts`；`writeFailures` 与 `recordProbe` 已在第七轮接上）。`counts()` 曾带一个假的调用点声明：注释写着「供 `/health`
   与管理后台」，而 `/health` 的 handler 完全不调 scheduler。已改为显式标注
   「无生产调用点」，与 `snapshot()`/`status()` 同格式。这类成员现已有六个
   （`snapshot` / `status` / `surfacesFor` / `counts` / `writeFailures` ×2 /
   `recordProbe`），**逐个标注是手工约定而实例还在增加** ——
   该建一道关卡（对白名单外的导出成员断言至少有一个非定义处引用）

   > **Phase 8 没有接上其中任何一个**，这一点要说清楚而不是含糊过去。
   > `doctor.mjs` 报的是 Worker 的**配置形态**（从 `config.json` 读，用
   > `isUsable()` 判定），**不是**调度器的运行期状态 —— 后者住在服务进程里，
   > 而进程外没有任何出口拿到它。所以 doctor 的第 4 层明确写着「『可用』只表示
   > 配置形态对；它是否**就绪**（不在冷却中）眼下无法从外部查到」。
   >
   > 要接上它们需要一个 HTTP 端点（Phase 9 的管理 API）。在那之前，
   > 给 doctor 硬塞一个「就绪数」只能靠重新实现一遍冷却判定 —— 那正是
   > 纪律 #4 禁止的第二份并行真相，而它必然与调度器的那份分叉。
13. ~~**`recordProbe()` 无生产调用点且无测试覆盖**~~ —— **已接**进
   `EgressService.probeProxy`（汇合点）。**Phase 9 批次 1 起那条 SQL 真的在生产
   执行过了**：`POST /api/probe` 触发探测后 `probe_results` 第一次有了行
   （在此之前它零调用点，参数顺序与列名从未被验证过）
14. **`requestCounts()` 是唯一随时间线性变慢的聚合**（已加 `sinceDay` 参数，管理 API 应总是传它）：`COUNT(DISTINCT
   request_id)` 全表扫，实测 100k 行 **12.4ms**、1M 行约 124ms，而它是同步
   调用 —— 接 HTTP 端点后会阻塞事件循环那么久。容量本身不是问题
   （实测 100k 行 21.6 MB，按每天 600 行算约 47 MB/年，不需要清理机制），
   但加端点时该给它一个 `sinceDay` 参数，与 `modelUsage`/`rates` 一致
15. ~~**`restore()` 绕过容量上限**~~ —— **已修**：`LIMIT` 从 `SESSION_CAP`/`BLOB_CAP` 推导，取最新的 cap 条。原文：：`loadSessions`/`loadBlobs` 没有 `LIMIT`，
   而 `restore()` 不调 `evict`。今天不会越界（DB 是内存的忠实镜像、内存有
   cap），但它**依赖一个没有守卫的不变量**：「DB 行数 ≤ cap」。
   `SESSION_CAP` 被调小、或从一个旧库/备份恢复时会不成立。
   修法是 `LIMIT` 从内存侧的 cap 推导（那两个常量目前是 `affinity.ts` 私有，
   `affinityStore.ts` 拿不到 —— 本身就是分叉隐患）
16. ~~**统计写失败没有生产读者**~~ —— **已接**进 `/health` 的 `storeWriteFailures`。原文：：`StatsStore` 与
   `AffinityStore` 都吞掉写异常并计数（统计是诊断设施，不该让转发失败），
   但那个计数目前**没有调用方** —— 与 `Scheduler.snapshot()` 同一个形态。
   一个一直写失败的库会安静地给出全 0 报表，而那看起来像「没人用」。
   `doctor.mjs` 应当报它（→ Phase 8）
17. ~~**「我们自己丢了用量」被记成「上游没报」**~~ —— **已分开**（`requests_dropped_usage`）。原文：：`createUsageCollector.dropped()`
   的文档明写它与 `usage() === null` 必须分开，否则「覆盖率会把我们自己丢的
   计成上游没报的」—— 而 `recordUsage` 只看 `totals`，全仓 `.dropped()` 的唯一
   读者是一行日志（第七轮审核查出）。两个入口都可达：一条 >1MiB 的 `data:` 行
   被 `MAX_LINE_LENGTH` 整条弃掉，以及**上游中途断流**（更常见）。
   与「上游从不报用量显示成 100% 覆盖」严格对称，而处置方向相反
   （一个要改代码、一个不用）。修法是给 `model_usage` 加一列或让
   `recordUsage` 入参带上 `dropped`（→ Phase 9 做统计页时一起）
18. **`SUM()` 的 int64 溢出仍未挡住**：`MIN(SUM(x), MAX_SAFE)` 只挡住了
   「JS 转换阶段的越界」，而 `SUM` 的累加本身是 int64 —— 实测 **1025 个饱和行**
   （每行 MAX_SAFE = 2^53，2^53 × 1024 = 2^63）时 SQLite 直接报
   `integer overflow`，`MIN` 来不及夹。可达性极低（要上游持续报天文数字，
   41 模型 × 3 Worker 约 9 天），但**注释与测试声称的性质比实际强**。
   若要真做到，`CAST(MIN(total(x), MAX_SAFE) AS INTEGER)` 可以
   （`total()` 返回 REAL 不溢出，实测 1025 行下正确返回）
19. **`latencyMs` 可为负、非整数会丢整行**：`clock` 可注入任意实现而
   `latencyMs = clock() - startedAt` 无下界也不取整。实测 `1.5` 会让 STRICT 表
   拒绝 REAL 进 INTEGER 列 → `recordAttempt` **整条事务回滚**，明细与累计
   两条记录都丢（只留一个 `writeFailures` 计数）；`-5000` 照常写进库。
   生产上 `clock` 恒为 `Date.now` 所以不可达，但 `Math.max(0, Math.round(...))`
   的代价是一行，理由与 `clampTokens` 同源
20. ~~**明细表无保留策略**~~ —— **已加**：启动时清 30 天前的明细，并开 `secure_delete`（否则「已清理」是假保证）。原文：：`pruneExpired` 只管
   两张亲和表（它的注释说「增长受内存侧容量上限约束」，那句只对亲和表成立）。
   容量不是问题（实测约 157 B/行，每天 600 行约 47 MB/年），但**毫秒级时间戳
   让它成为一份作息时间线** —— 在「意外把文件复制/打包出去」这个已列明的
   威胁下，明细比聚合值敏感得多。另：`secure_delete` 默认关闭且 `VACUUM`
   也清不掉已删页，所以加保留期时要一并 `PRAGMA secure_delete = ON`
21. ~~**目录拉空与上游不可达在外部看起来一样**~~ —— **前提本身是错的，已在
   Phase 8 实测纠正**。原文写「两者都让 `/v1/models` 返回 `data: []` 加
   HTTP 200」，而实测：从未成功拉到目录时 `routes/models.ts` 返回
   **502 `upstream_unreachable`**（它的注释早就写明了理由）。

   真正给出 `200 + data:[]` 的是**另一种**情况：目录**拉到了**（`total: 80`）
   而免费集为空（`free: 0`）—— 把 `freeSuffix` 改成一个没有模型命中的值即可
   复现。两者的下一步完全不同（设 CA／查出口 vs 查 `freeSuffix`），
   所以 `doctor.mjs` 仍把它们分成两层，只是分界线与原先记的不一样，
   判据是 `zen_gateway_catalog.total`。

   `doctor` 的第 6 层还额外查**服务进程**的 `NODE_EXTRA_CA_CERTS`
   （读 `/proc/<pid>/environ`，不是自己的 `process.env`）—— 那是纪律 #8：
   验证工具必须与产品代码共享同一套信任配置，而 doctor 与服务是两个进程。
   `docs/usage.md` 里同一处失实说法也已改。

22. **`GLOBAL` 分组在 rule 模式下切了不生效，而这个故障不报任何错**
   （Phase 8 实测发现）。`setup.mjs` 按「可出口节点数」挑 selector，而本机
   `GLOBAL` 与 `Proxy` **都是 69 个** —— 按名字 tiebreak 会选中 `GLOBAL`。
   但内核 `mode` 是 `rule`，此时规则把流量导向 `Proxy` 这类分组，
   `GLOBAL` **不参与选路**（实测它的 `now` 还停在 `DIRECT`）。

   后果：切 `GLOBAL` 什么都不改变 → 所有 Worker 走本机直连 → **共用同一个
   公网 IP**，而出口隔离正是本项目存在的理由。而控制面通、切换返回 204、
   探测也能拿到 IP —— 只有 `doctor --deep` 的隔离报告会发现它。

   `setup.mjs` 已按 `mode` 把 `GLOBAL` 降级（只在没有别的候选时用它，并告警）。
   **但这是个启发式，不是守卫**：一个名字不叫 `GLOBAL` 却同样不参与选路的
   分组仍会被选中。真正的判据是「规则实际把流量导向哪个分组」，而那要解析
   `/configs` 的 rules —— 眼下不做（→ Phase 10 做多内核择优时一并考虑）。
   兜底手段是 `doctor --deep`：它按实测公网 IP 分组，共用出口一定会被报出来。

23. **`service.mjs --open` 指向 Vite dev server（5173），不是网关端口**：
   实测网关**不伺服** `dist/admin`（`GET /` 返回 404），只有 `/health`、
   `/v1/*`、`/api/*` 三组路由。所以 `--open` 打开 5173，需要另开
   `npm run dev`。Phase 9 若让网关自己伺服静态产物，`ADMIN_URL` 要跟着改 ——
   那时是一处真实修改，不是遗漏（→ Phase 9）

24. **doctor 报不了「Worker 是否就绪」**：见缺口 #12 的补注 —— 运行期冷却状态
   住在服务进程里而进程外没有出口。doctor 的第 4 层只能报配置形态，
   并已把这个限制明写在输出里（→ Phase 9 的管理 API）
