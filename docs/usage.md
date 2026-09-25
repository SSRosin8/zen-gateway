# 使用

## 命令

```bash
npm start            # 构建 → 后台启动 → 健康等待 → 打印 URL
npm start -- --open  # 同上，并打开管理后台（需另开 npm run dev）
npm stop
npm run restart      # 同样会先构建
npm run status       # 运行状态 / pid / 端口
npm run open         # 只打开管理后台（服务没跑时报错，不开一个连不上的页面）
npm run setup        # 一键探测本机 Clash Controller 并写进配置
npm run doctor       # 分层诊断，只报第一个失败的层 + 下一步建议
npm run doctor -- --deep    # 额外实测每个出口的公网 IP（会切 Clash 节点）
npm run validate     # typecheck(server+admin+test) + 全部测试 + 双构建
npm run discover:upstream   # 重验上游怪癖（需网络，不进 validate）
npm run dev          # 管理后台 dev server（Vite，5173）
```

`start`/`restart` 都串了构建 —— 先前只启动不构建，改完代码 `npm start` 会静默跑旧产物。

**端口**按 `ZG_PORT` > `config.json` 的 `gateway.port` > `9876` 解析，三处
（服务端、`service.mjs`、vite 代理）共用同一份实现。

**`ZG_DATA_DIR`** 可以把 `data/` 挪到别处（测试与多实例用）。

### 管理后台

```bash
npm start            # 先起网关
npm run dev          # 再起前端（5173）
npm run open         # 打开浏览器
```

眼下只有 **Overview** 一页（其余 5 页在后续批次）。它回答三个问题：
网关能不能用、**出口隔离成立吗**、某个 Worker 为什么没在被用
（停用／没 key／在冷却，三种的下一步完全不同）。

最后那条先前**无法回答** —— `config.json` 知道「配了什么」，调度器知道
「现在能不能用」，而进程外没有地方同时持有这两半（`npm run doctor` 只能报
配置形态，并在输出里明写了这个限制）。

**「探测出口」按钮**会实测每个在用出口的公网 IP 并写回配置。在点它之前
隔离视图只能显示「未探测」—— 而「还不知道」不算作已隔离。

管理面**仅本机可访问**（只认内核报告的 TCP 对端地址，绝不采信
`X-Forwarded-For`），且**绝不回显凭证**：API key / Relay Token / Clash secret
一律只显示 8 位指纹，供人眼比对「是不是我刚填的那个」。

### 出问题先跑 `npm run doctor`

它按**依赖顺序**分七层查（配置 → 服务 → 统计库 → Worker → Clash 控制面 →
模型目录 → 出口实测），**只报第一个失败的层**。后面的层在它修好之前给不出
有意义的答案 —— 平铺式的输出会同时报「上游不可达」「Worker 不就绪」
「目录为空」三条，而它们其实是同一个根因（Clash 没开）的三个症状。

`doctor` 是**只读**的：不生成配置、不跑数据库迁移（库以 `readOnly` 打开）、
不改权限。唯一的例外是 `--deep` —— 桥接探测必须切 Clash 的 selector
（那是进程外的全局状态），所以跑完之后选中节点是最后探测的那个，它会提前告知。

### 企业网络下必须设 `NODE_EXTRA_CA_CERTS`

如果所在网络对 `opencode.ai` 做 TLS 中间人（内网 DNS 把它解析到内网地址、
证书由企业 CA 签发），**Node 不读系统 CA 库**（它用编译进二进制的那一套），
于是所有上游请求都失败：

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start
```

怎么判断是否需要它 —— **`npm run doctor` 的第 6 层会直接告诉你**，而且它查的是
**服务进程**的环境变量而不是你当前 shell 的（两者可以不同：服务可能是带着
变量启动的，而你手敲 doctor 时没带）。

**不能用 `curl` 判断**：`curl` 读系统 CA 库，所以它会正常返回 200，而网关
同时是失败的。要自己验就用 Node 问：

```bash
node -e 'fetch("https://opencode.ai/zen/v1/models").then(r=>console.log(r.status)).catch(e=>console.log("需要设置:",e.cause?.message))'
```

**症状**：网关照常启动、`/health` 返回 `ok: true`，而 `/v1/models` 返回
**HTTP 502 `upstream_unreachable`**。日志里是这一行：

```
目录拉取失败(keyed): fetch failed ← unable to get local issuer certificate
```

`←` 右边是 `err.cause`。`fetch failed` 是 undici 的顶层包装，真正的原因一律在右边。

> **这里先前写的是「返回 HTTP 200 加一个空列表」，那是错的**（2026-09-25 实测）。
> `routes/models.ts` 在从未成功拉到目录时返回 **502**，它的注释写明了理由：
> 空列表会让 OpenCode 显示「没有可用模型」，而那与「网关拿不到目录」是两件事。
>
> 真正会给出 `200 + data:[]` 的是**另一种**情况：目录**拉到了**而免费集为空
> （`freeSuffix` 配错，或上游把带后缀的模型全下架）。两者的下一步完全不同，
> 所以 `doctor` 把它们分成两条不同的诊断，判据是响应里的
> `zen_gateway_catalog.total`（有 total 而 free 为 0 = 后者）。


---

## 客户端配置

覆盖 OpenCode 内置的 `opencode` provider，只给 `baseURL` 与 `apiKey`：

```jsonc
// <project>/opencode.json 或 ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode": {
      "options": {
        // 端口用 `npm run status` 打印的那个，别照抄
        "baseURL": "http://127.0.0.1:9877/v1",
        "apiKey": "<gateway.relayToken>"
      }
    }
  }
}
```

**不要写 `models` 块**：内置 provider 自带模型表，手写一份会随上游目录变化而过期。

> 项目级 `opencode.json` 含 Relay Token，**已在 `.gitignore` 里**，不要提交。

验证：

```bash
opencode run --model opencode/mimo-v2.6-flash-free "Reply with exactly: OK"
```

> **只能用真实 OpenCode CLI 验，`curl` 不算。** 免费额度闸门查请求**形态**不查 key，
> 手搓 `curl` 必然得到 `403 FreeTierError` —— 那是预期行为，不是故障证据。
>
> 判据也不止看 CLI 输出：还要在 `data/zen-gateway.log` 里看到对应的
> `用量 chat/...` 行，否则无法排除 CLI 其实绕过了网关直连上游。

---

## 配置文件

`data/config.json`（0600，整个文件都可能是凭证）。首启自动生成。

```jsonc
{
  "version": 1,
  "gateway": {
    "port": 9876,                 // 默认值；本机实际用 9877（9876 被旧项目占着）
    "baseUrl": "https://opencode.ai/zen/v1",
    "relayToken": "<首启自动生成的 43 字符>",
    "headersTimeoutMs": 60000,    // 等首字节，可以严格
    "bodyTimeoutMs": 300000,      // 字节间空闲，流式必须宽松
    "maxAttempts": 3              // 一条客户端请求最多尝试几个 Worker
  },
  "models": {
    "freeSuffix": "-free",
    "extraFreeIds": ["big-pickle"],   // 无后缀但零费率的模型
    "defaultSurfaces": ["chat", "responses"],
    "surfaceOverrides": {},
    "catalogTtlMs": 1800000,          // 在架目录的**新鲜期**（不是硬过期）
    "enforceCatalog": true            // 免费判定是否与在架目录求交集
  },
  "workers": [],
  "proxies": [],
  "subscriptions": [],
  "clash": { "enabled": false, "selectionMode": "auto", "activeBridgeId": null, "bridges": [] },
  "routing": {
    "strategy": "anonymous_first",
    "cooldown": {
      "rateLimitMs": 900000,      // 限流冷却；上游的 Retry-After 优先
      "authFailMs": 60000,        // 鉴权失败：固定短退避，不随次数增长
      "transportBaseMs": 2000,    // 传输失败的指数退避起点
      "transportMaxMs": 120000
    },
    "affinityTtlMs": 3600000      // 会话粘滞的**闲置**上限（滑动）
  }
}
```

几处要注意的：

- **`strictObject`**：拼错字段名会**报错**而不是被忽略。手工编辑是预期用法，
  所以宁可吵闹。
- **引用完整性在加载时校验**：`workers[].proxyId` 指向不存在的代理会直接拒绝启动。
  这不是洁癖 —— 静默退回本机直连意味着该 Worker 与其他 Worker 共用出口，
  而出口隔离是这个项目存在的理由。
- **缺 `version` 即视为配置损坏**，不做旧项目配置迁移。
- **损坏的配置绝不自动覆盖**（会连凭证一起丢）。报错只给字节位置，不回显内容。
- `routing.strategy` 按 Worker 的 `kind` 排序，三个取值产出三种不同顺序。
  但**实践中你大概看不出区别**：可排序的只有 `anonymous` 与 `authenticated`
  两类，而上游已关闭免 key 通道，所以正常配置里全是 `authenticated` ——
  同一类别内部保持配置顺序，于是三个取值结果相同。想手工排优先级就直接改
  `workers` 数组的顺序。
- **`affinityTtlMs` 是闲置时长，不是绑定寿命**：每次请求都会刷新，所以一条持续
  活跃的会话永不换 Worker。固定寿命会在长对话中途强制换人，而那恰好是粘滞
  要避免的事（客户端回放的加密推理块会被上游拒）。
- **会话键超过 4096 字符时不参与亲和**（退化成策略排序），而不是被截断。
  截断发生在哈希之前等于摘要被截断 —— 前缀相同的两个会话会共用一个绑定。
- **`catalogTtlMs` 是新鲜期，不是硬过期**：过期只触发一次后台刷新，拉不到就
  继续用旧的，而且旧目录**永不因为太旧而失效**。一份三天前的目录远好于
  "网关拒绝一切"。默认 30 分钟 —— 目录以天为单位变化，更短没意义。
- **`enforceCatalog` 关掉的是交集，不是免费判定**：后缀与名单照常生效。
  留这个开关是因为交集依赖能联网拉到目录，而离线环境或本地假上游拉不到 ——
  那种情况下你应当能明确关掉它，而不是困在"模型全说已下架"里。

### 免费判定：（后缀 ∪ 名单）∩ 在架目录

三条依据缺一不可，而**交集是已下架模型自动失效的唯一机制**：

```bash
# 已下架的 glm-5-free 后缀命中，但不在上游在架目录里 → 403，且**不打上游**
# → "模型 glm-5-free 已不在上游在架目录中(它符合免费约定,但上游已下架)"
```

少了交集它会被放行，再由上游返回 400 `Model is unavailable.` —— 你看到的是
上游措辞，指不到"把这个 id 从 `extraFreeIds` 里删掉"。

**有一个不对称必须知道**：交集能自动剔除**下架**的，但**新出现的无后缀免费
模型无法自动发现** —— 上游的 `/models` 给在架性却不给价格。所以新的零费率
无后缀模型只能手工补进 `extraFreeIds`（`big-pickle` 就是这么来的）。
**点一下刷新不会自动拿到全部免费模型。**

`/v1/models` 的响应体里带一个 `zen_gateway_catalog` 诊断字段（网关自己加的，
不属于 OpenAI 契约），可以直接看目录状态：

```bash
curl -s -H "authorization: Bearer <relayToken>" http://127.0.0.1:9877/v1/models \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).zen_gateway_catalog))'
# { slot: 'keyed', total: 42, free: 10, fetched_at: 1790256502000, fresh: true }
#   ↑ total/free 都会变（上游目录以天为单位变动，且 total 按账号不同），
#     这里只是形状示例 —— 别把这两个数字当预期值。
```

`total` 是上游在架总数，`free` 是过滤后你能用的数量，`fresh` 是这份目录是否还在
新鲜期内。**连续多次查询 `fetched_at` 不变**就说明缓存在工作（没有每次都打上游）。

### 三个协议面

| 客户端路径 | 面 | 说明 |
|---|---|---|
| `/v1/chat/completions`、`/chat/completions` | `chat` | OpenCode 默认用这个 |
| `/v1/responses`、`/responses` | `responses` | 体内 `previous_response_id` 作会话指针 |
| `/v1/messages`、`/messages` | `messages` | Anthropic Messages 形状 |

三个面都收带 `/v1` 与不带的两种路径（客户端 `baseURL` 两种写法都常见），
且**都经同一道鉴权与免费判定**。`models.defaultSurfaces` 与 `surfaceOverrides`
记录"哪个模型支持哪些面"，供后台展示用；放行判定只看免费集，不看这两张表。

### 各类失败冷却多久

| 类别 | 冷却 | 常见原因 |
|---|---|---|
| `rate_limit` | `Retry-After` 或 15 分钟 | 上游限流 |
| `auth` | 固定 60 秒 | key 粘错、被吊销、额度耗尽 |
| `transport`/`timeout` | 2 秒起指数增长，上限 2 分钟 | 出口不通、Clash 没开 |
| `bad_request` | **不冷却** | 请求本身的问题，与 Worker 无关 |

`auth` 刻意用固定短退避而不是指数增长：配错的 key 应该**反复暴露**，
而指数增长会让"key 配错了"逐渐变成"网关有点慢"。

> **冷却状态目前没有查看入口。** `npm run status` 只报进程信息（pid／版本／
> 运行时长／URL），不含 Worker 就绪数。调度器的 `snapshot()`（每个 Worker 的
> 就绪态、剩余冷却、连续失败数、最近失败类别）已经实现且不含凭证，
> 但要等 Phase 9 的管理 API 才有地方读它。眼下只能从响应头
> `x-zen-gateway-route` 与 `x-zen-gateway-worker` 推断（见下文「排查」）。

一个实际现象：**任何非 OpenCode 客户端**（curl、别的网关）打进来都会拿 403
`FreeTierError`，而 403 归 `auth` —— 于是全部 Worker 被打进 60 秒冷却。
这是自愈的（短退避 + 全员冷却时给最早恢复的那个），不影响真实 CLI，
但若你刚用 curl 探过，随后一分钟内的请求会带 `x-zen-gateway-route: all_cooling`。

---

## 绑定独立出口

这是这个网关的核心功能。每个 Worker 绑一个 `proxyId`，`null` 表示走本机直连。

```jsonc
{
  "workers": [
    { "id": "w1", "name": "", "kind": "authenticated",
      "apiKey": "<zen key>", "enabled": true, "proxyId": "node-us" },
    { "id": "w2", "name": "", "kind": "authenticated",
      "apiKey": "<另一个 zen key>", "enabled": true, "proxyId": "node-jp" }
  ],
  "proxies": [
    { "id": "node-us", "name": "US", "type": "anytls",
      "host": "127.0.0.1", "port": 7897,
      "enabled": true, "source": "controller",
      "bridgeId": "clash-1", "clashNodeName": "🇺🇲 US-1",
      "direct": false, "bridgeable": true, "egressIp": null },
    { "id": "node-jp", "name": "JP", "type": "anytls",
      "host": "127.0.0.1", "port": 7897,
      "enabled": true, "source": "controller",
      "bridgeId": "clash-1", "clashNodeName": "🇯🇵 JP-1",
      "direct": false, "bridgeable": true, "egressIp": null }
  ],
  "clash": {
    "enabled": true,
    "selectionMode": "manual",      // 严格用 activeBridgeId，不在它挂掉时悄悄换
    "activeBridgeId": "clash-1",
    "bridges": [
      { "id": "clash-1", "name": "clash-verge", "enabled": true, "priority": 100,
        "apiBase": "http://127.0.0.1:9097", "apiSecret": "<Controller secret>",
        "localProxyHost": "127.0.0.1",
        "localProxyPort": 7897,        // 从 Controller 的 /configs 读 mixed-port
        "selectorGroup": "Proxy" }     // 专用分组，不要用 GLOBAL
    ]
  }
}
```

四个实测出来的注意点：

**`localProxyPort` 要从 Controller 的 `/configs` 读 `mixed-port`**，不要用文档
默认的 `7890`，也不要照抄下面的数字 —— 它**随内核而变**（实测 Clash Verge 是
`7897`，0dcloud 是 `17891`），而且某些内核的 `port`/`socks-port` 都是 0。
硬编码任何一个值都会让桥接静默连到一个没人监听的端口。

```bash
# 端口按你的 Controller，下面用 Clash Verge 的 9097 举例
curl -s -H "Authorization: Bearer <apiSecret>" \
  http://127.0.0.1:9097/configs | grep -o '"mixed-port":[0-9]*'
```

> **较新的内核需要 `apiSecret`**，免鉴权访问只会得到 401。而有些 GUI 客户端
> （实测 0dcloud v2.0.30）把 secret 放在加密 IPC 里、外部拿不到 ——
> 那种内核无法被本网关驱动，即使它的数据面端口是通的：切换节点必须走控制面。

**`selectorGroup` 不要用 `GLOBAL`。** 切 `GLOBAL` 会改掉那个 Clash 实例上
**所有**流量的出站，包括浏览器和其他程序。建一个专用 selector 分组只放要隔离的节点。

**只把活着的内核写进 `bridges` 并 `enabled`。** `auto` 模式在
`activeBridgeId` 不可用时会按 priority 回落到另一个，于是流量去一个没人
监听的本地端口，症状是"代理明明配了却连不上"。

**`egressIp` 由探测填写，不要手填。** 隔离判定按它分组；`null` 归入"未知"
而不算已隔离 —— "还不知道"和"确认不同"是两件事。

---

## 排查

```bash
# 端口按你的 gateway.port —— 用 `npm run status` 打印的那个,别照抄 9876。
# 本机曾同时跑着旧项目(9876)与本网关(9877),照抄会拿到**另一个进程**的
# `{"ok":true}`,看起来一切正常而其实问错了人。
curl -s "http://127.0.0.1:$(node -e 'import("./src/store/port.ts").then(m=>console.log(m.resolvePort()))')/health"

# Clash Controller。端口与 secret 按你的 bridges 配置（下例是 Clash Verge）
curl -s -H "Authorization: Bearer <apiSecret>" \
  http://127.0.0.1:9097/version                 # Controller 是否活着
curl -s -H "Authorization: Bearer <apiSecret>" \
  http://127.0.0.1:9097/connections \
  | grep -o '"chains":\[[^]]*\]'                # 流量实际走了哪个出站节点
```

`/connections` 是**出口的唯一真相**：它直接给 `chains`（实际出站节点链）与
`rule`（命中哪条规则）。比"探测一个第三方 IP 回显服务"可靠 ——
后者可能与转发命中不同的 Clash 规则分支。

常见症状：

| 症状 | 可能原因 |
|---|---|
| 401 | Relay Token 不对，或客户端没带 `Authorization` |
| 403 `model_not_allowed`，消息说"不在免费集内" | 网关的免费闸门拦的：后缀不命中且不在 `extraFreeIds` 里 |
| 403 `model_not_allowed`，消息说"已不在上游在架目录中" | 交集拦的：它符合免费约定但上游已下架，把它从 `extraFreeIds` 里删掉 |
| 403 `FreeTierError` | **上游**拦的，与 key 无关（闸门查请求形态） |
| 400 `Model is unavailable.` | 模型已下架而本地目录还没刷新，或这个账号看不到它（整份目录按账号不同，见 `upstream-quirks.md` §7） |
| 500 且用的是 `/v1/messages` | 上游那个面从 `x-api-key` 读凭证。本网关已镜像，若仍出现说明镜像失效了 —— 见 `upstream-quirks.md` §8 |
| 503 `egress_unavailable` | 本机出口配置问题：代理停用、Clash 没开、缺 selector 分组、**Clash 开了鉴权而 `apiSecret` 为空或不对**（消息会直接说「检查 apiSecret 配置」） |
| 502 | 上游不可达（传输层失败） |
| 502 "无法获取上游模型目录" | 从没成功拉到过目录（上游或出口不通）。**不是**空模型列表 —— 那两件事刻意分开报 |
| 启动即退出 | 配置校验失败或端口被占，看 `data/zen-gateway.log` |

**确认流量真的经过网关**：停掉网关，同一条客户端命令必须失败
（`ConnectionRefused`）。这比读日志硬 —— 它排除了"客户端其实走了别的 provider"。

诊断响应头：

| 头 | 含义 |
|---|---|
| `x-zen-gateway-worker` | 这次由哪个 Worker 承接。失败时是最后一次尝试的那个 |
| `x-zen-gateway-route` | 为什么是它：`sticky`（会话粘滞）／`blob_hint`（推理指纹提示）／`strategy`（按策略排序）／`all_cooling`（全员冷却，给了最早恢复的那个） |
| `x-zen-gateway-attempts` | 这次一共尝试了几个 Worker（成功前重试过时 >1） |
| `x-zen-gateway-free` | **仅在放行未经在架核验时出现**：`suffix_unverified`／`extra_unverified`。有它 = 那一刻拿不到在架目录，所以只按后缀与名单放行了（见上文「免费判定」） |

前三个头在**成功与失败时都有**（第七轮审核补上了成功路径的 `attempts` ——
在那之前这句话对第三个头是假的）。`route` 先前只在成功路径设置，而这恰好让它在
最需要的时候缺席 —— 第五轮审核查出并修了。

`x-zen-gateway-free` 同理**两条路径都设**，而且失败时更有用：上游返回
400 `Model is unavailable.` 时，它回答的正是「目录说它在架但上游拒了」还是
「我们压根没拿到目录」—— 后者要查出口与网络，前者要查上游。

实测一串 curl 探针（每次都拿 403，而 403 归 `auth`）：

```
第 1 次: 403 | route: strategy    | worker: worker-11
第 2 次: 403 | route: strategy    | worker: worker-12
第 3 次: 403 | route: strategy    | worker: worker-13
第 4 次: 403 | route: all_cooling | worker: worker-12
```

前三次把三个 Worker 逐个打进 60 秒冷却，第四次全员冷却 → 给最早恢复的那个。
看到 `all_cooling` 就说明所有 Worker 都在冷却中，而响应里带的是上游的真实错误，
不是网关自造的 503。

---

## 上游怪癖

见 [`upstream-quirks.md`](upstream-quirks.md)，每条带日期、触发条件与原始响应。
`npm run discover:upstream` 可随时重验，上游行为一变就退出 1。

最需要知道的三条：

- **免费模型对手搓 curl 返回 403，但真实 OpenCode 客户端经本网关可用** ——
  闸门查的是请求**形态**，而原样透传不改变形态。
- **`/messages` 面从 `x-api-key` 读凭证，只给 Bearer 会 500**（§8）。网关已经
  自动镜像，你不需要做什么 —— 但值得知道，因为那个 500 会被归类成"上游错误"
  并**归咎于 Worker**，于是少了这个头就会把整池 Worker 打进冷却。
- **401 的 content-type 是 `text/plain` 但体是 JSON**（403/400 是
  `application/json`）。网关原样透传不纠错，否则这个上游 bug 会被藏起来。

---

## 日志里能看到什么

`data/zen-gateway.log`（0600）。除了启动行与失败原因，转发成功时会记一行用量：

```
用量 chat/big-pickle: in=10929 out=21 total=10950 cacheRead=3392
```

格式是 `面/模型`，随后是 token 数。为 0 的缓存字段不打印。
**只有数字，不含任何响应内容** —— 对话正文绝不进日志。

上游没报用量时**不打这一行**（免费模型未必报），所以看不到它不代表出错 ——
但那次请求仍会进数据库的 `requests_without_usage`（见下）。

---

## 运行时数据库

`data/runtime.db`（SQLite WAL，0600，与 WAL/SHM 旁路文件一起收紧）。
存**可再生的运行时数据**：用量统计、上游尝试日志、Worker 计数、探测结果、
会话与推理指纹亲和。凭证与用户意图全在 `config.json`，不在这里。

**打不开不影响启动**：统计与亲和持久化都是可用性改善，不是转发的正确性前提。
库坏了（磁盘满、档位高于本程序）网关照常起，只是退回纯内存 —— 日志会说明。
想重置统计直接删掉它，重启自动重建（**只丢统计，不丢配置**）。

### 三张聚合表分别答什么

| 表 | 答的问题 | 粒度 |
|---|---|---|
| `worker_stats` | 哪个账号被用得多／失败多 | 累计（不可按时间切） |
| `model_usage` | 哪个模型烧了多少 token、缓存命中多少 | 按 (模型, Worker, UTC 日) |
| `gateway_rejections` | **被网关自己挡了多少、为什么** | 按 (原因, 协议面, 模型, UTC 日) |

`upstream_attempts` 与 `probe_results` 是**明细**，答"什么时候发生了什么"——
它们有 **30 天保留期**（启动时清一次）。删明细不损失上面三张表的统计能力，
那正是分开存的理由；而明细的毫秒级时间戳合起来是一份作息时间线，
不该无限期攒着。

### 网关拒绝：`not_free` 与 `retired` 要分开看

两者处置完全不同：

- **`not_free`** —— 模型名不符合免费约定。你配错了模型名。
- **`retired`** —— 免费依据成立（后缀或名单命中）但**已不在上游在架目录**。
  去 `models.extraFreeIds` 里把那个 id 删掉。

其余五种（`body_*` / `model_missing` / `stream_unsupported` / `no_worker`）
里最值得看的是 **`no_worker`**：它意味着全池冷却或全员不可用。

> 被拒请求里的 `model` 是**客户端可控**且**没通过任何校验**的字符串，
> 所以不形似模型 id（`[A-Za-z0-9._-]{1,64}`）的一律记成 `<other>` ——
> 否则每发一个不同的名字就建一行，而这张表没有免费闸门那道保护。

### 两条最容易搞错的语义

**请求数 ≠ 尝试数。** 一条 `w1 限流 → w2 成功` 的重试链是**一个**客户端请求、
**两次**上游尝试。`upstream_attempts` 按尝试记行、用 `request_id` 串起同一条链，
所以两个数字都能查到，且每次尝试都在对应 Worker 名下可见。

**缺失的用量如实记为缺失，不估算。** 而且有**三种**，不是两种：

| 列 | 含义 | 处置 |
|---|---|---|
| `requests_with_usage` | 拿到了 | — |
| `requests_without_usage` | **上游没报**（免费模型常见） | 不用改 |
| `requests_dropped_usage` | **我们自己**没解析完整 | 看我们的界定常量 |

后两者必须分开：处置方向相反。少记 `without` 会让覆盖率虚高（一个「上游从不报」
的模型显示成 100% 覆盖）；把 `dropped` 折进 `without` 则把"我们丢了"伪装成
"上游没报" —— 于是你会去查上游，而真实原因在我们这边。

`dropped` 非 0 时看 `/health` 之外还要看日志里那行「响应过大,本次未能完整解析
用量」。注意 `dropped` 与 `with_usage` **可以同时成立**：`dropped` 的语义是
「这条响应没被完整解析」，而尾部的 usage 事件可能恰好落在丢弃之前的那一段里。

用量**归属实际承接者**：上面那条链里 token 记在 **w2** 名下，不是候选链首位的 w1。
多账号场景下「哪个账号烧了多少」正是最要紧的那个数字。

### 亲和持久化

重启后会话粘滞**不归零**：绑定在每次变更时镜像落盘，启动时装回内存
（日志里会有 `已恢复亲和绑定:会话 N 条、推理指纹 M 条`）。

内存仍是唯一的**查询**来源 —— `node:sqlite` 是同步 API，把亲和查询换成查库
等于在每请求的关键路径上阻塞事件循环。代价是进程被 `kill -9` 时可能丢掉
最后一刻的绑定，后果只是那条会话下一轮重挑一次 Worker。

两张亲和表只存 **sha256 摘要**，且 schema 的 `CHECK` 把这条从约定变成结构约束
（长度 64 且只含小写十六进制）——原始会话标识与推理内容结构上进不去。

### 现在还没有查看入口

聚合查询已经实现（per-model token、Worker 计数、缓存命中率、usage 覆盖率、
最近尝试），但**没有 HTTP 端点** —— 管理 API 的形状留给 Phase 9。
眼下要看数据直接查库：

```bash
# 不依赖外部 sqlite3 命令 —— 用 Node 内置的 node:sqlite（本项目的运行时要求）
node -e 'const{DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync("data/runtime.db",{readOnly:true});
console.table(db.prepare("SELECT model, worker_id, input_tokens, output_tokens, requests_with_usage, requests_without_usage FROM model_usage").all())'
```

装了 `sqlite3` 命令的话也可以直接查（注意它不在本项目的依赖里）：

```bash
sqlite3 data/runtime.db "SELECT model, input_tokens, output_tokens, requests_with_usage, requests_without_usage FROM model_usage"
```

统计写失败会被吞掉（不该让转发失败）但**有计数**，而 `/health` 会报它：

```bash
curl -s http://127.0.0.1:9877/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).storeWriteFailures))'
```

**0 是正常值。非 0 说明库有问题**（磁盘满／权限／档位不匹配），统计数字不可信 ——
一个一直写失败的库会安静地给出全 0 报表，而那看起来像「没人用」。
