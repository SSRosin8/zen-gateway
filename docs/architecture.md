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
│   ├── routing/select.ts Worker 选择（Phase 3 的最小实现）
│   ├── upstream/        fetch / retry / pipe / headers / url
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
做模糊对照（70 万次，零分歧）。

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
| 5 | 选 Worker | — |
| 6 | 重试链 | 只看 status + headers，**body 不消费** |
| 7 | 流式透传 | **唯一**写出客户端字节的地方 |

第 3、4 步都判定"请求本身"的问题，在本机就能定论，不该花一次上游调用去换
一个已知的答案。

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

| # | 不变量 | 状态 |
|---|---|---|
| 1 | **重试链与流式泵分层**：`retry.ts` 只依据 status+headers，返回 body **未被消费**；字节写出全部在 `pipe.ts`，且在重试链彻底结束之后 | ✅ |
| 2 | **body 取消的非对称**：非最后一次尝试必须 `cancel()`（否则连接泄漏）；**最后一次必须保留** body（让客户端看到上游真实错误） | ✅ |
| 3 | **流结束后的亲和结算**：SSE 可以带着 200 返回"推理已失效"，必须有结算钩子解绑 | Phase 5 |
| 4 | **不可重试的 4xx 要记成功**：400/422 是请求本身的问题，不归咎 Worker —— 否则一次坏请求能把所有健康 Worker 逐个打进冷却 | ✅ 判定 / Phase 5 接冷却 |
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
| 5 | 调度状态机：`workerPool` / `cooldown` / `affinity` / `select` | 待做 |
| 6 | 其余协议面 + 完整免费注册表（与在架目录求交集） | 待做 |
| 7 | 统计 SQL 聚合 | 待做 |
| 8 | `setup.mjs`（一键配置）、`doctor.mjs`（分层诊断） | 待做 |
| 9 | 管理后台 6 页 + 首启向导 + 批量探测长任务状态机 | 待做 |
| 10 | 订阅拉取与多格式解析、多 Clash 内核择优 | 待做 |
| 11 | 精简 `AGENTS.md`、4 个 skill、`docs/` 补全 | 部分 |

**885 测试全绿**（28 个文件：unit 19 / integration 6 / design 1 / admin 2）。
经四轮独立子 agent 审核，共修复 44 项确认缺陷。

### 当前已知缺口

1. **免费判定还没有与在架目录求交集**。完整判定是「（后缀命中 ∪ `extraFreeIds`）∩ 在架目录」，
   缺交集会**放得偏宽**：已下架的 `xxx-free` 会被放行，然后由上游返回
   400 `Model is unavailable.`（→ Phase 6）
2. **`/v1/models` 每次请求都打一次上游**，没有启动预热与最后成功缓存 —— 上游抖动时目录会跟着消失（→ Phase 6）
3. **目录是 per-Worker 的**（实测：带 key 与免 key 看到不同目录），所以缓存键必须含 Worker 身份（→ Phase 6）
4. **配置热更新只有形状没有入口**：`configOf()` 已做成函数，但没有改配置的 API（→ Phase 9）
5. **调度是最小实现**：按配置顺序排候选，无冷却、无粘滞、不读 `routing.strategy`。
   刻意不放半成品 —— 半实现的粘滞比没有粘滞更糟（→ Phase 5）
6. **探测目标与转发目标不同域**（见上文出口隔离节）
