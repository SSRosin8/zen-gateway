# 使用手册

本文描述当前仓库中的可用行为。所有示例使用占位值；`<...>` 需要换成你自己
环境中的值。网关只服务本机，管理 API 不应暴露到局域网或公网。

## 安装和运行

需要 Node.js 24 或更高版本。

网关和管理后台是两个独立进程：

```bash
npm install
npm start         # 终端 1：构建并后台启动网关
npm run dev       # 终端 2：Vite 管理后台，固定 http://127.0.0.1:5173
npm run open      # 可选：用浏览器打开 5173
```

- `npm start` 先构建，再启动网关、等待 `/health` 并打印实际 URL；端口也可用
  `npm run status` 查看。`npm start -- --open` 在启动成功后顺带打开浏览器。
- 网关端口只提供 `/health`、`/v1/*`、无前缀协议别名和 `/api/*`，不提供页面，
  `GET /` 返回 404。
- `npm run dev` 启动 Vite（端口 5173，被占用时直接失败），只把 `/api` 和
  `/health` 代理到网关；转发请求仍要打网关端口的 `/v1`。
- `npm run open` 和 `--open` 只确认网关健康，然后打开 5173；它们不检查 Vite 是否
  在运行，未运行 `npm run dev` 时浏览器会连接失败。
- `npm run dev:server` 以 `node --watch` 直接运行源码中的网关，适合开发；它不写
  状态文件，`npm stop` 不管理它。

```bash
npm stop
npm run restart
npm run status
npm run doctor
npm run doctor -- --deep
```

`doctor` 默认只读。`--deep` 会真实探测 IP 回显目标，桥接探测期间会切换 Clash
selector，结束后 selector 可能停在最后一个节点；结果的含义见
[回显 IP 的测量范围](#回显-ip-的测量范围)。

端口按 `ZG_PORT`、`data/config.json` 的 `gateway.port`、默认值 9876 解析。服务端、
service 脚本和 Vite 代理使用同一解析逻辑。数据目录可用 `ZG_DATA_DIR` 指定，
适合测试或运行多个隔离实例。

### 导入 Clash 出口

```bash
npm run setup -- --dry-run   # 只显示探测和合并结果
npm run setup                # 写入 data/config.json
npm run restart
```

setup 支持 `--api <http://127.0.0.1:端口>` 与 `--secret <值>`；API 地址必须是本机
HTTP 回环地址。

运行中的服务不会重新读取外部修改的配置文件。setup 写入后到重启完成前，不要在
管理后台保存任何配置：后台保存会把进程内的旧配置整份写回磁盘，覆盖刚导入的代理
和 Clash 内核。

## 管理后台

启动方式见[安装和运行](#安装和运行)。后台包含概览、网关、代理池、Worker、模型和
用量六页。候选池里没有 Worker（未配置、全部停用或认证 Worker 缺 key）时会显示首启向导；全部冷却不算。

当前 UI 支持：

- 网关页编辑最多尝试的 Worker 数（`maxAttempts`），并按 OpenCode 1.x/2.x 生成
  客户端配置片段（Relay Token 为占位符）。
- Worker 新增、编辑、删除；编辑时留空 key 表示保留旧值。认证 Worker 必须有 key，
  界面不单独提供“清空 key”，要去掉 key 就改为匿名 Worker。删除前弹出确认框；
  Worker 可在列表内直接编辑，出口从代理下拉框选择。
- 模型免费后缀、显式免费名单、目录交集开关的编辑。
- 代理分页、批量探测、按 IP 回显目标的实测公网 IP 分组的视图。
- 订阅刷新、探测进度、统计和运行期 Worker 状态查看；启动批量探测前需要确认。
- 深色主题：默认跟随系统，页头可切换“跟随系统 / 浅色 / 深色”。
- 轮询失败时保留上次数据，页头提示连接中断及数据的时效，而不是清空页面。

代理和 Clash 内核的增删改仍通过 `data/config.json` 完成，保存后重启网关。后台
不会伪造一个管理端点来覆盖这些配置；Models 页中的 `defaultSurfaces` 与
`surfaceOverrides` 只影响展示提示，不是转发放行条件。

## 客户端接入

先运行 `npm run status` 取得服务实际端口。后台网关页可以选择 OpenCode 主版本并
复制对应片段。OpenCode 1.x 使用单数 `provider`/`options`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode": {
      "options": {
        "baseURL": "http://127.0.0.1:<实际端口>/v1",
        "apiKey": "<把 data/config.json 中 gateway.relayToken 的值填入>"
      }
    }
  }
}
```

OpenCode 2.x 使用复数 `providers`/`settings`。只覆盖已有 `opencode` provider 的连接设置，
不要填写 `package` 或 `models`；OpenCode 会继续管理内置 SDK 和模型目录：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "opencode": {
      "settings": {
        "baseURL": "http://127.0.0.1:<实际端口>/v1",
        "apiKey": "<把 data/config.json 中 gateway.relayToken 的值填入>"
      }
    }
  }
}
```

选择对应版本的片段放进 `~/.config/opencode/opencode.json` 或项目根目录，token 是
占位符，仍需填入真实值。不要把具体模型或 SDK package 从 OpenCode 配置复制到这里，
否则会覆盖 OpenCode 自己维护的目录。

转发面用 `Authorization: Bearer <Relay Token>` 鉴权；`/v1/messages`（及无前缀的
`/messages`）另外接受
`x-api-key: <Relay Token>`，便于 Anthropic 形态的客户端直接使用；两者同时出现时以
Bearer 为准，其余路径只认 Bearer。客户端的 `x-api-key` 不会转发到上游。

### 客户端验收

用真实 OpenCode CLI 验证：

```bash
opencode run --model opencode/big-pickle "Reply with exactly: OK"
```

- 确认经过网关：停止服务后重复命令应连接失败，重启后恢复。
- 手工 curl 的请求头和请求体与真实 CLI 不同，某个探针得到的 403 或 500 不能推广
  到所有客户端。
- OpenCode 2.0.12 的隔离实测确认，`providers.opencode.settings` 会覆盖
  `baseURL`/`apiKey`，但只对客户端自身模型目录中已存在的模型发起请求。CLI 报
  `Model unavailable` 表示客户端目录没有该模型，不是网关没有接管 Base URL。
- 验收匿名 Worker 时为每次测试使用新的会话和隔离的 `PWD`、`OPENCODE_CONFIG`、
  `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`；已有会话的亲和绑定优先于
  `anonymous_first`，会继续使用原 Worker。
- 实际承接的 Worker 以响应头 `x-zen-gateway-worker` 和运行库为准，官方控制台记录
  不能单独证明本机中继用了哪个 Worker。
- 当前免费模型的真实验收范围是 Chat Completions 和 Responses；Messages 的状态见
  [需求文档 §13](requirements.md#13-当前未实现或需要外部配合的范围)。
- `/v1/models` 返回 `502 upstream_unreachable` 表示目录从未成功取得；若日志包含
  `unable to get local issuer certificate`，见[企业 CA](#企业-ca)。

## 配置文件

首次启动创建 `data/config.json`，权限为 0600。配置必须包含 `version` 和
`gateway.relayToken`，其余字段按 schema 默认值补齐；未知字段会拒绝启动。损坏配置不会
自动覆盖。引用不存在的 Worker、代理、订阅或 Clash 内核也会拒绝启动。

下面是包含主要顶层字段及其默认值的配置示例（凭证为占位符，`routing` 省略时取默认值）：

```jsonc
{
  "version": 1,
  "gateway": {
    "port": 9876,
    "baseUrl": "https://opencode.ai/zen/v1",
    "relayToken": "<至少 16 位 URL-safe token>",
    "headersTimeoutMs": 60000,
    "bodyTimeoutMs": 300000,
    "maxAttempts": 3
  },
  "models": {
    "freeSuffix": "-free",
    "extraFreeIds": ["big-pickle"],
    "defaultSurfaces": ["chat", "responses"],
    "surfaceOverrides": {},
    "catalogTtlMs": 1800000,
    "enforceCatalog": true
  },
  "workers": [],
  "proxies": [],
  "subscriptions": [],
  "clash": { "enabled": false, "selectionMode": "auto", "activeBridgeId": null, "bridges": [] }
}
```

下面的出口绑定片段可以直接合并进同一配置；引用的 id 在片段内部自洽：

```jsonc
{
  "workers": [
    { "id": "worker-a", "name": "匿名出口", "kind": "anonymous", "apiKey": "", "enabled": true, "proxyId": "proxy-a" }
  ],
  "proxies": [
    { "id": "proxy-a", "name": "本机 HTTP", "type": "http", "host": "127.0.0.1", "port": 8080, "enabled": true, "source": "manual", "direct": true, "bridgeable": false, "egressIp": null }
  ]
}
```

订阅也可以先只加入这个片段，再补齐其它顶层字段：

```jsonc
"subscriptions": [
  { "id": "sub-demo", "name": "示例订阅", "url": "https://airport.invalid/link?token=fake-token" }
],
```

配置字段的关键语义如下：

- `workers[].kind` 为 `authenticated` 时必须有 `apiKey`；`anonymous` 会归一化为
  空 key，绝不自动替换成其它字面量。
- `workers[].proxyId` 为 `null` 表示本机直连。代理必须同时声明 `direct` 或
  `bridgeable` 至少一个能力。
- `gateway.maxAttempts` 限制一次客户端请求最多尝试的 Worker 数；限流、上游错误、
  超时和传输错误会按失败分类进入重试链，客户端请求本身的错误不会归咎于 Worker。
- `headersTimeoutMs` 是等响应头的上限，`bodyTimeoutMs` 是流式响应字节之间的空闲
  上限。修改这两个字段后，新连接使用新值，在途连接保持原值。
- `catalogTtlMs` 是目录新鲜期。刷新失败时继续使用旧目录，不会因为目录变旧而
  拒绝所有请求。`enforceCatalog` 只控制目录存在时的交集，不改变没有目录时按
  后缀和名单放行的行为。
- 免费判定是 `(freeSuffix 命中 ∪ extraFreeIds) ∩ 在架目录`。目录从未成功拉取时，
  `/v1/models` 返回 502；目录成功但免费集为空时才返回 `200` 与空 `data`。
  `/v1/models` 触发的刷新失败后同样进入退避，退避期内直接用旧目录或返回 502，不再
  逐请求打上游。

### 调度 `routing`

`routing` 可省略，省略时全部取默认值。后台没有编辑入口，修改后需重启。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `strategy` | `anonymous_first` | 就绪 Worker 的排序：`anonymous_first` 匿名优先、`authenticated_first` 认证优先、`mixed` 按配置顺序；同类内保持配置顺序，会话亲和命中优先于策略 |
| `cooldown.rateLimitMs` | 900000 | 429 冷却；上游给了 `Retry-After` 时以它为准，但不短于 `transportBaseMs`；不加抖动 |
| `cooldown.authFailMs` | 60000 | 401/402/404（key 失效、额度耗尽）的固定短冷却（附最多 25% 抖动），不按失败次数翻倍 |
| `cooldown.forbiddenMs` | 5000 | 403 的短冷却（范围 1000–600000，附最多 25% 抖动），并换下一个 Worker 重试；免费闸门按请求形态返回 403、地区限制按出口返回 403，都不代表 Worker 故障 |
| `cooldown.transportBaseMs` | 2000 | 传输、超时、上游 5xx 指数退避的起点 |
| `cooldown.transportMaxMs` | 120000 | 上述指数退避的上限 |
| `affinityTtlMs` | 3600000 | 会话亲和的滑动闲置时长，范围 60000–86400000 |

```jsonc
{
  "routing": {
    "strategy": "anonymous_first",
    "cooldown": { "rateLimitMs": 900000, "authFailMs": 60000, "forbiddenMs": 5000, "transportBaseMs": 2000, "transportMaxMs": 120000 },
    "affinityTtlMs": 3600000
  }
}
```

目录尚未核验的模型收到上游 401 时，网关不把它记为该 Worker 的鉴权失败，因为
免 key 请求不存在的模型同样返回 401。“已核验”指开启 `enforceCatalog` 且判定依据不是
`*_unverified`。不归咎 Worker 的失败（坏请求、出口配置错误、上述 401）不增加也不
清零连续失败次数，只有成功才清零。

### Worker 和凭证写入

管理 API 的配置写入使用三态凭证 patch：字段缺席表示不动，`{"set":"..."}` 表示
替换，`{"clear":true}` 表示清空。API 从不回传原始 key、Relay Token、代理密码或
Clash secret，只返回是否存在和短指纹。配置写入会先校验完整 schema，再原子替换
文件；并发保存遇到版本冲突时返回失败，要求刷新后重试。

## 出口和 Clash

每个 Worker 绑定一个代理 id，或者使用 `null` 直连。直连协议包括 HTTP、HTTPS、
SOCKS4 和 SOCKS5；其它协议必须经 Clash 桥接。桥接配置的结构如下：

```jsonc
{
  "clash": {
    "enabled": true,
    "selectionMode": "manual",
    "activeBridgeId": "bridge-a",
    "bridges": [
      {
        "id": "bridge-a",
        "name": "本机 Clash",
        "enabled": true,
        "priority": 100,
        "apiBase": "http://127.0.0.1:9090",
        "apiSecret": "<Controller secret>",
        "localProxyHost": "127.0.0.1",
        "localProxyPort": 7890,
        "selectorGroup": "Proxy"
      }
    ]
  }
}
```

`localProxyPort` 必须与 Controller `/configs` 返回的 `mixed-port` 一致，不能把
示例端口当作通用值。`selectorGroup` 应是规则实际导向的专用选择器；`GLOBAL` 在
rule 模式下可能不参与选路，在 global 模式下则会影响本机其它流量。

分组参与选路还不够，上游域名自己也要命中这个分组。企业 DNS 会把 `opencode.ai`
解析到内网地址，这时排在前面的私网 `IPCIDR,10.0.0.0/8,DIRECT` 之类规则先命中，
所有 Worker 的 Zen 请求直连、共用一个出口，而回显报告仍显示各自独立。
`npm run doctor` 第 5 层（Clash 控制面）会用内核自己的 DNS 解析上游域名，按规则
顺序找出首条命中；不经过所选分组时给出告警。处理方式是在 Clash 规则最前面加
`DOMAIN-SUFFIX,opencode.ai,<selectorGroup>`，或让内核用公网 DNS 解析该域名。

规则要加在订阅更新后仍会保留的位置。Clash Verge 这类客户端会用“订阅 + 用户扩展”
重新生成内核实际加载的运行配置：写在订阅对应的规则扩展（prepend 规则）或全局扩展
脚本里的规则会在每次订阅更新、重新生成后保留；直接编辑生成出来的运行配置只在当次
生效，下一次重新生成时会被覆盖。改完后在 Controller 的 `/rules` 确认该规则位于私网
`IPCIDR` 规则之前，再运行 `npm run doctor`。

`manual` 严格使用 `activeBridgeId`，不会因为它失联而悄悄切换；`auto` 在有健康的
当前内核时保持粘滞，否则按 priority 选择。转发路径不会逐请求探活或自动切换。
批量探测会锁定一个内核，避免两批任务同时改动 Clash 的全局 selector。

桥接模式下 selector 锁覆盖“切换节点 + 建立连接”，连接建立后即释放，不再等到响应
头到达，所以长时间生成的非流式请求不会阻塞同一内核下的其他 Worker。为保证 Clash
在切换后才选路，桥接连接统一经 HTTP CONNECT 隧道建立。

`egressIp` 只能由探测写回，`null` 是“尚未测量”，不代表已与其它出口独立。

### 回显 IP 的测量范围

后台回显出口报告、批量探测和 `npm run doctor -- --deep` 测的都是 IP 回显服务（优先
`api.ipify.org`）看到的公网 IP，而不是 Zen 请求的出口：

- 回显服务和 `opencode.ai` 可能命中 Clash 的不同规则；回显走了所选节点，Zen 请求
  仍可能走 `DIRECT`。多个回显 IP 不同不能证明 Zen 请求已隔离。
- 两个代理 NAT 到同一个公网 IP 时属于共用出口；未测出 IP 的不计为独立。
- selector 切换成功、节点延迟正常同样不能作为 Zen 选路证据。
- 要确认 Zen 实际出口，在真实 CLI 请求期间读 Clash `/connections`，核对目标为
  `opencode.ai` 的连接的 `chains` 与 `rule`；排查细节见
  [debug-egress](../.claude/skills/debug-egress/SKILL.md)。

## 订阅和批量探测

订阅刷新依次尝试多种 User-Agent，解析 Clash YAML/JSON、SIP008、分享链接列表及
多层 Base64：拿到含节点的 Clash/SIP008 结构化结果即停止，否则在总时长上限内取
节点最多的结果。节点 id 由订阅 id 与节点名派生，重复
刷新不会重复添加；用户改过的 `enabled` 与已测 `egressIp` 会保留。订阅 URL 是
凭证，界面、API 和错误消息都会脱敏。

代理池的批量探测分为本地筛选和 IP 回显目标探测两段，进度由服务端保存。任意时刻
只能有一批；进程被强制终止后遗留任务会标为 interrupted。探测完成后即使结果写回
配置失败，任务仍会结束；日志会记录写回错误，需要修复存储问题后重新探测。

## 管理 API

所有 `/api/*` 端点都只接受本机回环 TCP 对端，Host 必须是回环主机；有 Origin 时
也必须是回环 HTTP(S) 来源。本表是端点清单的唯一维护处。

| 方法与路径 | 用途 | 是否写配置 |
|---|---|---|
| `GET /api/ping` | 服务存活检查 | 否 |
| `GET /api/overview` | Worker 运行态、目录和隔离概览 | 否 |
| `GET /api/stats?days=N\|all` | 用量与拒绝统计 | 否 |
| `GET /api/proxies` | 代理列表、引用者和解析失败原因 | 否 |
| `GET /api/models` | 含付费模型的目录与判定理由 | 否 |
| `PATCH /api/config` | 网关设置（`maxAttempts`、两个超时、Relay Token）、模型规则、Worker CRUD | 是 |
| `POST /api/probe` | 探测在用出口并写回 IP | 是 |
| `GET /api/batch-probe` | 查看批量探测进度 | 否 |
| `POST /api/batch-probe` | `start`、`pause`、`resume`、`cancel` | 可能 |
| `POST /api/subscriptions/:id/refresh` | 拉取、解析并合并一个订阅 | 是 |

## 诊断和故障排查

先运行：

```bash
npm run doctor
npm run status
```

doctor 按 1 配置、2 服务、3 统计库、4 Worker、5 Clash 控制面、6 模型目录、
7 回显出口实测（仅 `--deep`）的顺序检查，只报告第一个失败层；警告不中断后续层。
常见响应：

| 症状 | 方向 |
|---|---|
| 401 | Relay Token 缺失或不匹配；也可能是上游返回的认证失败，结合响应头与日志判断 |
| 403 `model_not_allowed` | 不符合免费规则，或符合规则但目录显示已下架 |
| 403 `FreeTierError` | 上游免费额度闸门，取决于请求形态；网关会换 Worker 重试，全部失败时返回最后一次的 403 |
| 403 `not available in your country` | 出口所在地区不可用该模型；网关会换 Worker 重试，全部失败时检查各 Worker 的出口地区 |
| 400 `Model is unavailable` | 上游目录已变化或账号看不到该模型 |
| 502 `upstream_unreachable` | 上游、出口、DNS 或 TLS 不可达 |
| 503 `no_worker_available` | 没有可入池的 Worker（未配置、全部停用或认证 Worker 缺 key）。全员冷却不返回 503：网关会尝试最早恢复的一个，上游响应带 `x-zen-gateway-route: all_cooling` |
| 503 `egress_unavailable` | 代理停用、Clash 不可用、selector 或 secret 配置错误 |
| 启动退出 | schema、引用完整性或端口冲突 |

响应头 `x-zen-gateway-worker`、`x-zen-gateway-route` 和
`x-zen-gateway-attempts` 只在请求实际到达上游后描述承接 Worker、路由来源和尝试
次数；目录缺失、按后缀或名单放行未经在架核验时另有 `x-zen-gateway-free`
（`suffix_unverified` / `extra_unverified`）。网关在选 Worker 前拒绝的请求没有这些头，应查看 `GET /api/stats` 的拒绝
计数和日志。

### 企业 CA

如果网络使用企业 CA，Node 默认信任集合可能不包含该 CA，而 curl 可能使用系统
证书库。按企业 CA 的实际路径设置 `NODE_EXTRA_CA_CERTS` 后再启动服务，并用
`npm run doctor` 检查服务进程的环境；不要只用 curl 判断网关是否能访问上游。

### 日志和数据库

`data/zen-gateway.log` 只记录脱敏的状态、错误和用量数字，不记录对话正文。
`data/runtime.db` 保存统计、探测和亲和状态；数据库不可用时网关仍可转发。已加载
store 的写入失败会计入健康信息；若启动时打不开数据库，统计、亲和持久化和批量
探测会停用，日志与统计 API 会报告不可用，但目前健康写失败计数仍可能为零。
因此排查时也要检查日志和用量页。数据库及其 WAL/SHM 文件可在停止服务后删除，
启动时会重建；这不会删除 `config.json`。

`npm stop` 或 SIGTERM/SIGINT 触发优雅关闭：先停止接收新请求，在有界时间内等待在途
请求完成（最多 5 秒，超时后强制断开），再关闭出口连接池和数据库。客户端中途断开的
请求以 499 结束，不记为转发失败。

用量区分请求数与上游尝试数，也区分上游没有上报用量和网关未能完整解析。后台用量
页默认显示最近 30 天，传 `days=all` 查询全部聚合数据。

## 验证

```bash
npm run validate
```

它按类型检查、双构建、测试的顺序执行。`npm run discover:upstream` 需要网络，
用于重新测量上游行为，单独运行。
