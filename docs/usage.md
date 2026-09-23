# 使用

## 命令

```bash
npm start            # 构建 → 后台启动 → 健康等待 → 打印 URL
npm stop
npm run restart      # 同样会先构建
npm run status       # 运行状态 / pid / 端口
npm run validate     # typecheck(server+admin+test) + 全部测试 + 双构建
npm run discover:upstream   # 重验上游怪癖（需网络，不进 validate）
npm run dev          # 管理后台 dev server（Vite，5173）
```

`start`/`restart` 都串了构建 —— 先前只启动不构建，改完代码 `npm start` 会静默跑旧产物。

**端口**按 `ZG_PORT` > `config.json` 的 `gateway.port` > `9876` 解析，三处
（服务端、`service.mjs`、vite 代理）共用同一份实现。

**`ZG_DATA_DIR`** 可以把 `data/` 挪到别处（测试与多实例用）。

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
        "baseURL": "http://127.0.0.1:9876/v1",
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
opencode run --model opencode/big-pickle "hello"
```

---

## 配置文件

`data/config.json`（0600，整个文件都可能是凭证）。首启自动生成。

```jsonc
{
  "version": 1,
  "gateway": {
    "port": 9876,
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
    "surfaceOverrides": {}
  },
  "workers": [],
  "proxies": [],
  "subscriptions": [],
  "clash": { "enabled": false, "selectionMode": "auto", "activeBridgeId": null, "bridges": [] },
  "routing": { /* cooldown 与 affinityTtlMs —— Phase 5 才生效 */ }
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
- `routing.strategy` 默认值是 `anonymous_first`，但**匿名 Worker 这条通道不实现**
  （上游已关闭第三方免费额度），且 Phase 3 的调度还没读这个字段。

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
      "host": "127.0.0.1", "port": 17891,
      "enabled": true, "source": "controller",
      "bridgeId": "clash-1", "clashNodeName": "🇺🇲 US-1",
      "direct": false, "bridgeable": true, "egressIp": null }
  ],
  "clash": {
    "enabled": true,
    "selectionMode": "manual",      // 严格用 activeBridgeId，不在它挂掉时悄悄换
    "activeBridgeId": "clash-1",
    "bridges": [
      { "id": "clash-1", "name": "mihomo", "enabled": true, "priority": 100,
        "apiBase": "http://127.0.0.1:9090", "apiSecret": "",
        "localProxyHost": "127.0.0.1",
        "localProxyPort": 17891,       // 从 Controller 的 /configs 读 mixed-port
        "selectorGroup": "Proxy" }     // 专用分组，不要用 GLOBAL
    ]
  }
}
```

四个实测出来的注意点：

**`localProxyPort` 要从 Controller 的 `/configs` 读 `mixed-port`**，不要用文档
默认的 `7890`。实测某机器上是 `17891`，而 `port`/`socks-port` 都是 0 ——
硬编码默认值会让桥接静默连到一个没人监听的端口。

```bash
curl -s http://127.0.0.1:9090/configs | grep -o '"mixed-port":[0-9]*'
```

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
curl -s http://127.0.0.1:9876/health            # ok / version / uptime / pid
curl -s http://127.0.0.1:9090/version           # Clash Controller 是否活着
curl -s http://127.0.0.1:9090/connections \
  | grep -o '"chains":\[[^]]*\]'                # 流量实际走了哪个出站节点
```

`/connections` 是**出口的唯一真相**：它直接给 `chains`（实际出站节点链）与
`rule`（命中哪条规则）。比"探测一个第三方 IP 回显服务"可靠 ——
后者可能与转发命中不同的 Clash 规则分支。

常见症状：

| 症状 | 可能原因 |
|---|---|
| 401 | Relay Token 不对，或客户端没带 `Authorization` |
| 403 `model_not_allowed` | 网关的免费闸门拦的，模型不在免费集 |
| 403 `FreeTierError` | **上游**拦的，与 key 无关（闸门查请求形态） |
| 400 `Model is unavailable.` | 模型已下架或该账号看不到它（目录是 per-Worker 的） |
| 503 `egress_unavailable` | 本机出口配置问题：代理停用、Clash 没开、缺 selector 分组 |
| 502 | 上游不可达（传输层失败） |
| 启动即退出 | 配置校验失败或端口被占，看 `data/zen-gateway.log` |

**确认流量真的经过网关**：停掉网关，同一条客户端命令必须失败
（`ConnectionRefused`）。这比读日志硬 —— 它排除了"客户端其实走了别的 provider"。

诊断响应头：`x-zen-gateway-worker`（这次由哪个 Worker 承接）、
`x-zen-gateway-attempts`（失败时尝试了几次）。

---

## 上游怪癖

见 [`upstream-quirks.md`](upstream-quirks.md)，每条带日期、触发条件与原始响应。
`npm run discover:upstream` 可随时重验，上游行为一变就退出 1。

最需要知道的两条：

- **免费模型对手搓 curl 返回 403，但真实 OpenCode 客户端经本网关可用** ——
  闸门查的是请求**形态**，而原样透传不改变形态。
- **401 的 content-type 是 `text/plain` 但体是 JSON**（403/400 是
  `application/json`）。网关原样透传不纠错，否则这个上游 bug 会被藏起来。
