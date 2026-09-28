# 使用手册

本文描述当前仓库中的可用行为。所有示例使用占位值；`<...>` 需要换成你自己
环境中的值。网关只服务本机；管理后台可以按[局域网访问](#局域网访问)显式开放给
同一局域网的设备，但不应暴露到公网。

## 安装和运行

需要 Node.js 24 或更高版本。

一条命令同时启动网关与管理后台：

```bash
npm install
npm start         # 构建并后台启动；打印网关地址与管理后台地址
npm run open      # 可选：用浏览器打开管理后台
```

- `npm start` 先构建（网关与后台页面），再启动网关、等待 `/health`，打印网关 URL 与
  管理后台 URL（默认 `http://127.0.0.1:5173`）；`npm run status` 也能查看。
  `npm start -- --open` 在启动成功后顺带打开浏览器。
- 网关进程占两个端口：网关端口（默认 9876，只监听 `127.0.0.1`）提供 `/health`、
  `/v1/*`、无前缀协议别名和 `/api/*`，`GET /` 返回 404；管理后台端口（默认 5173，
  `ZG_ADMIN_PORT` 可改，设为 `0` 不启动）伺服构建好的 `dist/admin`，并把 `/api` 与
  `/health` 交给网关，不提供 `/v1`。后台端口平时只监听 `127.0.0.1`，设置了局域网
  访问口令后改为 `0.0.0.0`（见[局域网访问](#局域网访问)）。后台端口被占用时网关照常
  运行，日志说明原因。
- `npm run dev` 是开发用的 Vite（热更新，也用 5173，只监听本机）。与 `npm start`
  同时运行时先启动的占住 5173；开发前先 `npm stop` 或设 `ZG_ADMIN_PORT`。
- `npm run dev:server` 以 `node --watch` 直接运行源码中的网关，适合开发；它不写
  状态文件，`npm stop` 不管理它。

```bash
npm stop
npm run restart
npm run status
npm run doctor
npm run doctor -- --deep
```

服务在运行时，后台诊断页（`GET /api/diagnostics`）给出同样的配置、统计库、Worker、
Clash 和目录几层结果；`doctor` 在服务停止时仍然可用。`doctor` 默认只读。`--deep` 会真实探测 IP 回显目标，桥接探测期间会切换 Clash
selector，结束后 selector 可能停在最后一个节点；结果的含义见
[回显 IP 的测量范围](#回显-ip-的测量范围)。

端口按 `ZG_PORT`、`data/config.json` 的 `gateway.port`、默认值 9876 解析。服务端、
service 脚本和 Vite 代理使用同一解析逻辑。后台网关页可改配置端口，写盘后要
`npm run restart` 才换监听端口。在此之前启停脚本与 `doctor` 按状态文件记录的端口
找到运行中的实例，`status`、已在运行时的 `start` 与 `doctor` 会提示端口待重启；
`npm run dev` 的代理按新端口转发，这段时间连不上运行中的网关。重启后在客户端接入页
重写 `opencode.json`。数据目录可用 `ZG_DATA_DIR` 指定，
适合测试或运行多个隔离实例。

首次启动（数据目录中还没有 `config.json`）时，如果项目根没有 `opencode.json`，服务会
在项目根生成一份，写入实际端口和真实 Relay Token（文件权限 0600，已被 `.gitignore`
忽略）。项目根是服务的工作目录，`npm start` 下即仓库根；`ZG_DATA_DIR` 不改变它。已有
`opencode.json` 时绝不自动覆盖；可用 `POST /api/opencode/write` 更新，已有文件只改
opencode provider 的 `baseURL` 与 `apiKey`，含注释或尾逗号的文件不会被改写。形状按
`opencode --version` 的主版本选择（1 → `provider`，≥2 → `providers`），探测不到时用 2.x 形状。

### 导入 Clash 出口

服务运行时也可以用 `POST /api/clash/import`（见[管理 API](#管理-api)）导入，写入即时生效、
无需重启。命令行方式：

```bash
npm run setup -- --dry-run   # 只显示探测和合并结果
npm run setup                # 写入 data/config.json
npm run restart
```

不带参数时 setup 会探测本机常见的 Controller 端口。Controller 设了 secret 时自动探测
只会报告“需要 secret”：从 Clash 配置文件的 `secret` 字段或客户端设置里的外部控制
（External Controller）处取得地址与 secret，再显式传入：

```bash
npm run setup -- --dry-run --api http://127.0.0.1:<端口> --secret '<secret>'
```

API 地址必须是本机 HTTP 回环地址。

运行中的服务不会重新读取外部修改的配置文件。用 `npm run setup` 写入后到重启完成前，
不要在管理后台保存任何配置：后台保存会把进程内的旧配置整份写回磁盘，覆盖刚导入的
代理和 Clash 内核。经管理 API 导入没有这个问题。

## 管理后台

启动方式见[安装和运行](#安装和运行)。后台使用左侧导航（可收起为图标栏），分为四组：
快速开始与概览；资源（Worker、出口）；设置（客户端接入、网关、模型）；运行（用量、诊断）。引导未完成时首次打开落在快速开始页，依次检查
目录可达、导入 Clash 出口、创建 Worker、OpenCode 项目配置和验证命令；新增 Worker 与
从 Clash 节点批量创建都在这一页完成，导入 Clash 成功后可直接从导入的节点创建。
导航层（侧栏、窄屏顶栏）是半透明毛玻璃，内容卡片保持实色；系统设置了「减少透明度」或
「提高对比度」时自动改为实色。侧栏底部有两个按钮：配色在“跟随系统 / 浅色 / 深色”之间
循环；皮肤在“冷灰蓝”与“暖米白”两套色板之间切换，只换颜色，不改布局与毛玻璃。

当前 UI 支持（每项都对应上面[管理 API](#管理-api)中的端点）：

- 概览页是「需要处理」清单：目录不可达、没有可用 Worker、Worker 共用回显出口、
  Worker 冷却中、`opencode.json` 未指向网关、配置端口已改但未重启、近期有请求被网关
  拒绝等，每条带一个跳到对应页面的处理入口；没有问题时只显示服务状态。
- Worker 页：新增、行内编辑、启停与删除；编辑时留空 key 表示保留旧值。认证 Worker
  必须有 key，要去掉 key 就改为匿名 Worker。可多选后批量启用、停用或删除。启停和删除
  匿名 Worker 的结果显示在对应行（或列表上方），10 秒内可撤销；删除认证 Worker 丢掉的
  key 后台找不回，所以先确认、不能撤销。可从未被引用的 Clash 节点一次批量创建匿名
  Worker；回显 IP 与已用节点或其他候选重复的节点会标「出口重复」，可一键去掉。
  「探测在用出口」逐个探测并显示进度，可中途停止，结果与失败原因写在对应行；切到别的
  页面探测照常进行，侧栏底部显示进度。回显出口一列标出共用，「共用出口」筛选只列出
  这些 Worker。点 Worker id 打开详情侧栏，汇总配置、运行状态、用量和出口（上游尝试是累计值，
  token 是近 30 天）。
- 出口页：节点列表（分页、多选批量启停 / 探测 / 删除、单个节点探测、改名；被 Worker
  引用的节点不能删；状态列同时显示回显 IP）。「添加手工代理」新建 HTTP / HTTPS /
  SOCKS4 / SOCKS5 直连代理，手工直连代理的更多操作里有「编辑连接」（协议、主机、端口、
  用户名、口令三态）；改了连接信息后回显出口变为未探测，要重新探测。导入的节点只能
  启停、改名和删除。批量探测覆盖全部已启用节点，逐行显示
  排队、探测中、成功或失败，启动前确认，可选「为可用且出口不重复的节点新建匿名
  Worker」（默认不勾）。取消后已探到的结果照样写回，没轮到的节点标「已跳过」，也不再
  新建 Worker；结束后行内只保留失败与跳过的原因，之后单独探测过的节点以新结果为准。订阅标签新建、编辑、删除与刷新订阅；Clash 标签探测并导入本机
  Clash Controller，内核在对应行下展开编辑（含 secret 三态），并设置启用模式与当前内核。
- 客户端接入页：Relay Token 指纹与轮换（确认框里默认勾选「同时写入 opencode.json」；
  文件未指向当前 token 时常驻重写提示），查看并一键写入项目根 `opencode.json`，按
  OpenCode 1.x/2.x 复制客户端配置片段（片段里的 Relay Token 为占位符），设置局域网
  访问口令。
- 网关页：实际监听信息与配置端口（重启后生效；由 `ZG_PORT` 指定时只读）；编辑最多
  尝试的 Worker 数、两个超时和调度设置（策略、亲和时长、
  各类冷却）。
- 模型页：编辑免费后缀、显式免费名单和目录交集开关。
- 用量页：时间范围今天（UTC）/ 7 天 / 30 天 / 全部，统计按 UTC 日分桶，所以「今天」从 UTC 零点算起；
  一张按天的图表，可切换按模型 / 按 Worker、面积 / 柱状（都堆叠）以及指标，下方是明细表；
  范围与图表视图都写在 URL 里，URL 里的范围无效时按 30 天显示。
  网关拒绝的模型可点进模型页查看原因。「重置统计」清空全部用量（不只是当前时间范围），
  出口探测历史、会话亲和与配置不受影响；需要确认，不能撤销。
- 诊断页显示进程内分层诊断，每层的下一步是可点的链接；回显出口实测放在 Worker 页与
  出口页，诊断页只给入口。
- 网关页、模型页的表单改过未保存时标出「未保存」，换页或关页前提醒；服务端的值在此期间
  变了会提示，可载入最新值。
- 轮询失败时保留上次数据，并提示连接中断及数据的时效；恢复连接后提示已重新连上。

模型页的「协议」列只作展示，不是转发放行条件（网关对每个模型都开放三个面）：

- 声明取自 models.dev 的 OpenCode 条目（OpenCode 按其中的 AI SDK 包名选择请求协议：
  `@ai-sdk/openai-compatible` → Chat，`@ai-sdk/openai` → Responses，`@ai-sdk/anthropic` → Messages，
  其他包显示「网关不支持的协议」）。这是第三方数据，可能落后于 Zen；网关启动后与打开模型页时
  在后台拉取（本机直连，不经 Worker 出口），成功后缓存 6 小时，失败 5 分钟后再试。拿不到时显示
  「声明拿不到」，模型不在其中时显示「未声明」。
- 「实测」是本网关近 30 天统计里对该模型得到过 2xx 的协议面，只在补充了声明以外的面时显示；
  统计明细按保留期清理，重置统计后清空。
- 两者都不证明 Zen 当前接受哪个面。旧配置里的 `models.defaultSurfaces` / `surfaceOverrides`
  已不再使用，加载时忽略，下次保存配置时移除。

## 局域网访问

默认关闭。开启步骤：

1. 在本机后台客户端接入页的「局域网访问」卡片设置访问口令（至少 8 位）。后台端口随即改为
   监听 `0.0.0.0`，不用重启；卡片里列出本机的局域网地址，例如
   `http://<本机局域网 IP>:5173`。
2. 局域网设备打开该地址，输入口令登录；会话 12 小时有效，保存在 `HttpOnly` cookie 里。
3. 关闭口令后后台端口退回只监听 `127.0.0.1`。

规则与限制：

- 登录后权限与本机相同（可改 Worker、填 API key、轮换 Relay Token）；访问口令只能在
  本机修改或关闭，局域网访客不能改掉口令。
- 更换或关闭口令会让所有已登录的局域网会话立即失效；网关重启后也需要重新登录。
- 连续 5 次口令错误后锁定 1 分钟，之后每次锁定时长加倍，最长 15 分钟。锁定是全局的，
  不按设备区分。
- 是否局域网请求按真实 TCP 对端判定：局域网设备把 Host 写成 `127.0.0.1` 也不会被当作本机。
- 只认私网 IP 字面量作为访问地址（`10/8`、`172.16/12`、`192.168/16` 与 IPv6 ULA
  `fc00::/7`）；用域名访问会被拒绝，以防 DNS rebinding。
- 网关端口仍只监听 `127.0.0.1`，转发面 `/v1/*` 不开放给局域网；后台端口只提供页面与 `/api`。
- 传输是明文 HTTP，口令与会话 cookie 在局域网上可被嗅探；只在可信网络里开启。
- `npm run dev` 不会开放到局域网：Vite 开发服务器会伺服项目目录下的源文件。

## 客户端接入

首次启动时没有任何 Worker，这时客户端请求会得到 503 `no_worker_available`。先在后台
Worker 页（或用 `PATCH /api/config`）至少建一个 Worker，再接入客户端。在本仓库目录里
运行 OpenCode 时，首启生成的项目级 `opencode.json` 已指向本网关；在其他目录使用时按下文
手工配置。

运行 `npm run status` 取得服务实际端口。后台客户端接入页可以选择 OpenCode 主版本并
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

选择对应版本的片段放进 `~/.config/opencode/opencode.json`，或只对某个项目生效时放进
运行 `opencode` 的那个目录下的 `opencode.json`。token 是占位符，仍需填入真实值；
文件含 Relay Token，建议 `chmod 600`。本仓库的 `.gitignore` 已忽略根目录的
`opencode.json`，其他仓库需自行忽略。不要把具体模型或 SDK package 从 OpenCode 配置复制到这里，
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
  网关 `/v1/models` 列出的免费模型不一定都在客户端目录里，验收应选两边都有的模型
  （如 `big-pickle`）。
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

`routing` 可省略，省略时全部取默认值。后台网关页可编辑，保存即时生效；手工改配置文件后需重启。

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

`egressIp` 的实测值只能由探测写回；手工直连代理的连接信息被修改时会置为 `null`。
`null` 是“尚未测量”，不代表已与其它出口独立。

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

出口页的批量探测覆盖全部已启用节点，分为本地筛选和 IP 回显目标探测两段，进度由服务端保存。任意时刻
只能有一批；进程被强制终止后遗留任务会标为 interrupted。探测完成后即使结果写回
配置失败，任务仍会结束；日志会记录写回错误，需要修复存储问题后重新探测。

## 管理 API

所有 `/api/*` 端点都只接受本机回环 TCP 对端。Host 是回环主机、Origin（如有）也是回环
来源时为本机请求；开启局域网访问后，Host 为私网 IP、Origin 同源且带有效口令会话的请求
也放行（`/api/lan/status` 与 `/api/lan/login` 免会话），见[局域网访问](#局域网访问)。
本表是端点清单的唯一维护处。

| 方法与路径 | 用途 | 是否写配置 |
|---|---|---|
| `GET /api/ping` | 服务存活检查 | 否 |
| `GET /api/overview` | Worker 运行态、目录和隔离概览 | 否 |
| `GET /api/stats?days=N\|all` | 用量与拒绝统计（`N` 为 1–3650，默认 30；含按天明细 `daily`） | 否 |
| `POST /api/stats/reset` | 清空全部用量统计（`{ confirm: true }`）；不动探测历史、会话亲和与配置 | 否 |
| `GET /api/proxies` | 代理列表、引用者和解析失败原因 | 否 |
| `GET /api/models` | 含付费模型的目录、判定理由与协议（models.dev 声明 + 本机实测） | 否 |
| `PATCH /api/config` | 严格补丁：`gateway`、`routing`、`models`、`workers`、`clash`、`proxies`、`subscriptions` | 是 |
| `POST /api/probe` | 探测出口并写回 IP（`{ proxyIds? }`，省略时探全部在用出口；与批量探测互斥，进行中得 409） | 是 |
| `GET /api/batch-probe` | 查看批量探测进度，含逐个节点的状态（`nodes`） | 否 |
| `POST /api/batch-probe` | `{ action: start\|pause\|resume\|cancel, createWorkers? }`；范围是全部已启用节点（加在用的本机直连），`createWorkers` 为真时为可用且出口不重复的节点建匿名 Worker；已有探测进行中或没有可探的出口时 `start` 得 409 | 可能 |
| `POST /api/subscriptions/:id/refresh` | 拉取、解析并合并一个订阅 | 是 |
| `POST /api/clash/discover` | 探测本机 Controller（`{ apiBase?, secret? }`） | 否 |
| `POST /api/clash/import` | 导入 Controller 的内核与节点（`{ apiBase, secret?, dryRun }`） | `dryRun: false` 时 |
| `GET /api/diagnostics` | 进程内分层诊断：配置、统计库、Worker、Clash、模型目录 | 否 |
| `GET /api/lan/status` | 局域网访问是否开启、本次请求是否本机或已登录；本机还返回可访问地址 | 否 |
| `POST /api/lan/login` | 局域网访客用口令换会话 cookie（`{ password }`；连续 5 次错误锁定） | 否 |
| `POST /api/lan/logout` | 注销当前会话 | 否 |
| `POST /api/lan/password` | 设置口令（`{ password }`，至少 8 位）或关闭（`{ password: null }`）；仅本机 | 是 |
| `GET /api/opencode` | 项目根 `opencode.json` 的状态与检测到的 OpenCode 版本 | 否 |
| `POST /api/opencode/write` | 创建或更新项目根 `opencode.json`（`{ version?: "1" \| "2" }`） | 写 `opencode.json` |

`PATCH /api/config` 各节的规则：

- 凭证字段（Worker `apiKey`、内核 `apiSecret`、订阅 `url`、代理 `password`、`gateway.relayToken`）是三态：
  缺席不动、`{ "set": "…" }` 替换、`{ "clear": true }` 清空；`gateway.relayToken` 另可
  `{ "rotate": true }`，由服务端生成新 token，响应不回显。轮换后客户端和
  `opencode.json` 里的旧 token 立即失效，需要重写。
- `workers`、`clash.bridges`、`subscriptions`、`proxies` 支持 `create`/`update`/`delete`。
  `proxies.create` 只建手工直连代理（`type` 为 `http`/`https`/`socks4`/`socks5`）；
  `proxies.update` 的 `type`、`host`、`port`、`username`、`password`（三态）只对手工直连
  代理生效，改到订阅、Controller 或桥接节点得 422；连接信息真的变了时 `egressIp` 置为
  `null`。`proxies.create` 一次最多 64 条；同一请求里不能删掉再同名新建代理。未知 id 得 404。
- `gateway.port` 只写盘；`GET /api/overview` 的 `gateway.port` 是实际监听端口，
  `configuredPort` 是配置值，两者不同且 `portFromEnv` 为假时表示等待重启。
- 被 Worker 引用的代理不能删除；删除 Clash 内核或订阅会连带删除它们导入的代理，
  其中有被引用的则整个请求失败（422，消息点名 Worker）。同一请求里先改绑 Worker
  再删除是允许的。
- `workers.create` 一次最多 512 条，与配置中 Worker 总数上限相同。

Clash 导入与 `npm run setup` 使用同一份探测和合并逻辑，`apiBase` 必须是本机 HTTP
回环地址（否则 400，且不会发出请求）；Controller 要求 secret 时得 401
`auth_required`。导入经热更新路径写入，无需重启。

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

token 口径与 OpenCode 一致：「输入」含缓存命中，「其中缓存读」是它的一部分，合计 =
输入 + 输出。OpenCode 每一轮请求都带着完整上下文，上游报的是整段对话到此为止的用量，
所以带 `x-opencode-session` 头的请求按（会话, 模型）只计最大的那一条，不逐轮相加；
请求计数仍逐条统计。没有会话头的请求（例如 curl）逐条相加。网关拒绝按原因与请求的
模型名列出，名字不像模型 id 的记为「未提供或名称不合法」。

## 验证

```bash
npm run validate
```

它按类型检查、双构建、测试的顺序执行。`npm run discover:upstream` 需要网络，
用于重新测量上游行为，单独运行。
