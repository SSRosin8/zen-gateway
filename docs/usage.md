# 使用手册

本文描述当前仓库中的可用行为。所有示例使用占位值；`<...>` 需要换成你自己
环境中的值。网关只服务本机，管理 API 不应暴露到局域网或公网。

## 安装和运行

需要 Node.js 24 或更高版本。

```bash
npm install
npm start
npm run dev       # 另开终端运行 Vite 管理后台
npm run open
```

服务端启动前会构建产物，启动脚本会等待健康检查并打印实际 URL。

```bash
npm stop
npm run restart
npm run status
npm run doctor
npm run doctor -- --deep
```

`doctor` 默认只读；`--deep` 会真实探测 IP 回显目标，桥接探测期间会切换 Clash
selector。回显结果不代表 Zen 实际连接的出口。`npm run setup -- --dry-run` 只显示导入结果，`npm run setup` 才写入
配置。setup 支持 `--api <http://127.0.0.1:端口>` 与 `--secret <值>`；API 地址
必须是本机 HTTP 回环地址。

端口按 `ZG_PORT`、`data/config.json` 的 `gateway.port`、默认值 9876 解析。服务端、
service 脚本和 Vite 代理使用同一解析逻辑。数据目录可用 `ZG_DATA_DIR` 指定，
适合测试或运行多个隔离实例。

## 管理后台

先运行网关，再运行 `npm run dev`。后台包含概览、网关、代理池、Worker、模型和
用量六页。没有可用 Worker 时会显示首启向导。

当前 UI 支持：

- Worker 新增、编辑、删除；编辑时留空凭证表示保留旧值，清空必须显式操作。
- 模型免费后缀、显式免费名单、目录交集开关的编辑。
- 代理分页、批量探测、按 IP 回显目标的实测公网 IP 分组的视图。
- 订阅刷新、探测进度、统计和运行期 Worker 状态查看。

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
否则会覆盖 OpenCode 自己维护的目录。用真实 OpenCode CLI 验证：

```bash
opencode run --model opencode/space-bunny-free "Reply with exactly: OK"
```

当前免费模型的真实 CLI 验收范围是 Chat Completions 和 Responses；Messages 的
网关协议链路已完成，但当前没有可验的免费 Zen 模型。停止服务后重复命令应连接
失败，重启后恢复，借此确认客户端确实经过本网关。手工 curl 的请求形态与真实
CLI 不同，不能把某个探针的结果推广到所有客户端。

OpenCode 2.0.12 的隔离实测确认，`providers.opencode.settings` 会覆盖
`baseURL`/`apiKey`，但只对客户端自身模型目录中已存在的模型发起请求。CLI 报
`Model unavailable` 表示客户端目录没有该模型，不是网关没有接管 Base URL。验收匿名
Worker 时为每次测试使用新的会话和隔离的 `PWD`、`OPENCODE_CONFIG`、
`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`；否则旧的认证会话亲和会优先于
`anonymous_first`。模型目录首次获取失败按契约返回 `502 upstream_unreachable`；若日志
包含 `unable to get local issuer certificate`，请在启动服务前设置服务进程的
`NODE_EXTRA_CA_CERTS`。

## 配置文件

首次启动创建 `data/config.json`，权限为 0600。配置必须包含 `version`、`gateway`
和 `relayToken`，其余字段按 schema 默认值补齐；未知字段会拒绝启动。损坏配置不会
自动覆盖。引用不存在的 Worker、代理、订阅或 Clash 内核也会拒绝启动。

下面是完整配置的最小结构示例（凭证为占位符）：

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

`manual` 严格使用 `activeBridgeId`，不会因为它失联而悄悄切换；`auto` 在有健康的
当前内核时保持粘滞，否则按 priority 选择。转发路径不会逐请求探活或自动切换。
批量探测会锁定一个内核，避免两批任务同时改动 Clash 的全局 selector。

`egressIp` 只能由探测写回。它按 IP 回显目标的实测公网 IP 分组，`null` 是“尚未测量”，
不代表该目标已与其它出口独立；探测目标与 Zen 可能命中不同规则，真实上游出口需在请求
期间核对 Clash `/connections`。

## 订阅和批量探测

订阅刷新会尝试多种 User-Agent，解析 Clash YAML/JSON、SIP008、分享链接列表及
多层 Base64，取能解析出最多节点的结果。节点 id 由订阅 id 与节点名派生，重复
刷新不会重复添加；用户改过的 `enabled` 与已测 `egressIp` 会保留。订阅 URL 是
凭证，界面、API 和错误消息都会脱敏。

代理池的批量探测分为本地筛选和 IP 回显目标探测两段，进度由服务端保存。任意时刻
只能有一批；进程被强制终止后遗留任务会标为 interrupted。探测完成后即使结果写回
配置失败，任务仍会结束；日志会记录写回错误，需要修复存储问题后重新探测。

## 管理 API

所有 `/api/*` 端点都只接受本机回环 TCP 对端，Host 必须是回环主机；有 Origin 时
也必须是回环 HTTP(S) 来源。

| 方法与路径 | 用途 | 是否写配置 |
|---|---|---|
| `GET /api/ping` | 服务存活检查 | 否 |
| `GET /api/overview` | Worker 运行态、目录和隔离概览 | 否 |
| `GET /api/stats?days=N\|all` | 用量与拒绝统计 | 否 |
| `GET /api/proxies` | 代理列表、引用者和解析失败原因 | 否 |
| `GET /api/models` | 含付费模型的目录与判定理由 | 否 |
| `PATCH /api/config` | 网关设置、模型规则、Worker CRUD | 是 |
| `POST /api/probe` | 探测在用出口并写回 IP | 是 |
| `GET /api/batch-probe` | 查看批量探测进度 | 否 |
| `POST /api/batch-probe` | `start`、`pause`、`resume`、`cancel` | 可能 |
| `POST /api/subscriptions/:id/refresh` | 拉取、解析并合并一个订阅 | 是 |

Vite 开发服务器只代理 `/health` 和 `/api`；转发请求必须使用网关端口和 `/v1`，
不能拿开发服务器端口测试上游转发。

## 诊断和故障排查

先运行：

```bash
npm run doctor
npm run status
```

doctor 按配置、服务、统计库、Worker、Clash、模型目录、出口的顺序检查，只报告
第一个失败层。常见响应：

| 症状 | 方向 |
|---|---|
| 401 | Relay Token 缺失或不匹配；也可能是上游返回的认证失败，结合响应头与日志判断 |
| 403 `model_not_allowed` | 不符合免费规则，或符合规则但目录显示已下架 |
| 403 `FreeTierError` | 上游免费额度闸门，取决于请求形态 |
| 400 `Model is unavailable` | 上游目录已变化或账号看不到该模型 |
| 502 `upstream_unreachable` | 上游、出口、DNS 或 TLS 不可达 |
| 503 `egress_unavailable` | 代理停用、Clash 不可用、selector 或 secret 配置错误 |
| 启动退出 | schema、引用完整性或端口冲突 |

响应头 `x-zen-gateway-worker`、`x-zen-gateway-route` 和
`x-zen-gateway-attempts` 只在请求实际到达上游后描述承接 Worker、路由来源和尝试
次数。网关在选 Worker 前拒绝的请求没有这些头，应查看 `GET /api/stats` 的拒绝
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

用量区分请求数与上游尝试数，也区分上游没有上报用量和网关未能完整解析。后台用量
页默认显示最近 30 天，传 `days=all` 查询全部聚合数据。

## 验证

```bash
npm run validate
```

它按类型检查、双构建、测试的顺序执行。`npm run discover:upstream` 需要网络，
用于重新测量上游行为，单独运行。
