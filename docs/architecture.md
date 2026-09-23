# 架构

## 一句话

客户端（OpenCode）→ 本网关（鉴权 → 免费判定 → 选 Worker → 重试链 → 流式透传）→ OpenCode Zen，
每个 Worker 经**各自独立的公网出口**发出。

---

## 目录划分

```
src/
├── shared/      # 三端唯一契约 —— 必须浏览器可移植（admin 会打包它）
│   ├── schema.ts    zod schema + 推导类型 + 引用完整性（438 行，最大的单文件）
│   ├── contract.ts  /health 与 poolHealth 的契约
│   ├── redact.ts    脱敏的单点定义
│   └── ip.ts        IP 校验（WHATWG URL 实现，不用 node:net —— 见下）
├── core/
│   ├── failures.ts      失败分类：仅依据 status + headers，绝不看 body
│   ├── protocols/       协议面注册表（types / registry / chat）
│   ├── models/free.ts   免费判定（读配置规则）
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
│   └── routes/          relay / models
├── store/
│   ├── paths.ts     data/ 与 config.json 的位置（轻量层，无第三方依赖）
│   ├── port.ts      端口解析的唯一真相
│   ├── config.ts    加载/校验/版本闸门/0600 原子写
│   └── db/          sqlite schema + 迁移执行器
└── admin/           React SPA（Phase 0 的骨架，完整页面在 Phase 9）
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
`runtime.db` 两张表的 `CHECK` 把这条约定变成结构约束。

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

当前只注册了 `chat`（`/v1/chat/completions` + `/chat/completions`）。
`responses` 与 `messages` 在 Phase 6，那也是这个抽象的验收：
新增面若还需要改路由或调度，抽象即失败。

接口**全部是只读判定**，在解析副本上做。规划里曾设计 `transformRequest`
改写请求体，实际去掉了：三个面在 Zen 各有原生端点（同形状换路径），
而改写需要 JSON 往返，与"原样透传"冲突。

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
| 6 | 其余协议面 + 完整免费注册表（与在架目录求交集） | 待做 |
| 7 | 统计 SQL 聚合 + 亲和持久化 | 待做 |
| 8 | `setup.mjs`（一键配置）、`doctor.mjs`（分层诊断） | 待做 |
| 9 | 管理后台 6 页 + 首启向导 + 批量探测长任务状态机 | 待做 |
| 10 | 订阅拉取与多格式解析、多 Clash 内核择优 | 待做 |
| 11 | 精简 `AGENTS.md`、4 个 skill、`docs/` 补全 | 部分 |

**1094 测试全绿**（35 个文件：unit 25 / integration 7 / design 1 / admin 2）。
源码 6752 行 / 测试 10819 行。经四轮独立子 agent 审核，共修复 44 项确认缺陷。

### 当前已知缺口

1. **免费判定还没有与在架目录求交集**。完整判定是「（后缀命中 ∪ `extraFreeIds`）∩ 在架目录」，
   缺交集会**放得偏宽**：已下架的 `xxx-free` 会被放行，然后由上游返回
   400 `Model is unavailable.`（→ Phase 6）
2. **`/v1/models` 每次请求都打一次上游**，没有启动预热与最后成功缓存 —— 上游抖动时目录会跟着消失（→ Phase 6）
3. **目录按「带 key／免 key」两种身份区分，不是 per-Worker**。先前这条写的是
   「目录是 per-Worker 的，所以缓存键必须含 Worker 身份」，而它给的证据
   （带 key 与免 key 看到不同目录）**只能证明这两种身份不同**。
   `upstream-quirks.md` §7 的实测进一步查明：**两个不同账号看到的差异项完全相同** ——
   所以那不是账号个体差异。Phase 6 的缓存因此只需两个槽位，而不是 N 个
   （→ Phase 6）
4. **配置热更新只有形状没有入口**：`configOf()` 已做成函数，但没有改配置的 API（→ Phase 9）
5. **亲和只在内存里**：`session_affinity` / `blob_affinity` 两张表结构已就绪，但服务端
   还没打开 `runtime.db`。重启会丢绑定 —— 后果是每条进行中的会话下一轮重挑一次
   Worker，不是数据损坏（→ Phase 7）
6. **探测目标与转发目标不同域**（见上文出口隔离节）
7. ~~**`routing.strategy` 无实际效果**~~ —— **这条先前是错的，已删除**。
   我曾断言「匿名 Worker 需要空 apiKey，所以可排序的类别只剩一种」，
   而 `WorkerSchema` 的 `refine` 是**单向**的：它只要求 authenticated 必须有 key，
   对 anonymous **不作任何约束**。所以 `{kind:"anonymous", apiKey:"..."}` 合法且可用
   （`isUsable` 只看 key 不看 kind），三个策略取值产出三种不同顺序，而
   `anonymous_first` 正是 schema 默认值 —— 默认配置下就生效。
   空的是**实践**输入集（关闭免 key 通道后没人有理由这么配），不是**合法**输入集。
8. **调度状态没有查看入口**：`Scheduler.snapshot()` 已实现（每个 Worker 的就绪态、
   剩余冷却、连续失败数、最近失败类别，且不含凭证），但 `npm run status` 只报进程
   信息，也还没有管理 API 读它。眼下只能从响应头 `x-zen-gateway-route` 与
   `x-zen-gateway-worker` 推断（→ Phase 8 的 `doctor.mjs` / Phase 9 的管理 API）
9. **`ProtocolSurface` 缺 `parseUsage`**：规划的接口列了这个成员（从上游响应里取
   token 用量），而全仓不存在。Phase 7 的门槛明确依赖它（per-model token、
   缓存命中、usage 覆盖率），且 Phase 6 每新增一个面都要实现它 —— 越晚加成本越高
   （→ Phase 6/7）
10. **`assertEveryRouteGuarded` 只检查"有没有守卫"，不检查"是哪个"**：一条只挂
   `relayAuth` 而没挂 `loopbackOnly` 的管理路由能通过断言。当前无活缺陷
   （管理面只有 `/api/ping`），但 Phase 9 加管理 API 时这正是第四轮那个缺陷的变体
   （→ Phase 9）
11. **管理面的 body 上限尚无处可设**：约束「管理 JSON body 有上限而转发透传无界」
   目前是**空洞成立**的 —— 管理侧没有任何读 body 的代码。Phase 9 加管理 POST 时
   必须同时加，否则这条约束会静默变成"不成立"（→ Phase 9）
