# zen-gateway

zen-gateway 是一个运行在本机的 OpenCode Zen 网关。它接收 OpenAI 兼容的
Chat Completions、Responses，以及 Anthropic Messages 请求，只放行配置为免费
模型的请求，并按 Worker 选择配置的直连或 Clash 出口；后台的公网 IP 探测只反映
IP 回显目标，Zen 实际出口需在请求期间核对上游连接。

这是单用户工具：上游固定为 Zen，管理面只监听本机回环地址，不提供多租户或
对外服务。请求体按原始字节转发，网关只解析路由、模型和流式事件所需的字段。

## 快速开始

需要 Node.js 24 或更高版本。

```bash
npm install
npm start
npm run dev       # 另开终端启动管理后台
npm run open      # 打开管理后台
```

首次启动会创建 `data/config.json` 并生成 Relay Token。管理后台的 Worker 页可
新增、编辑和删除 Worker；认证 Worker 填 Zen API key，匿名 Worker 不发送任何
上游凭证。代理和 Clash 内核可以手工写入配置，也可以用 `npm run setup` 探测
本机 Controller。

```bash
npm run setup -- --dry-run
npm run setup
npm run restart
npm run doctor
```

`setup` 会写入配置，但运行中的服务不会自动加载这些变更；第一次使用建议先运行
`--dry-run`，写入后执行 `npm run restart`。`doctor` 默认只读；
`npm run doctor -- --deep` 会真实探测 IP 回显目标的出口，并在桥接模式下切换
Clash selector；它不单独证明 Zen 实际请求的出口。

## 配置 OpenCode

网关实际端口由 `ZG_PORT`、`data/config.json` 的 `gateway.port`、默认值 9876
依次决定。先运行 `npm run status` 查看当前端口，再按
[`docs/usage.md`](docs/usage.md) 的兼容 OpenCode 1/2 配置示例替换端口和 Relay
Token。后台网关页可选择 1.x 或 2.x 格式生成对应配置块，其中 Relay Token 仍是占位符。

用真实 OpenCode CLI 验证当前可用的 Chat Completions 模型：

```bash
opencode run --model opencode/space-bunny-free "Reply with exactly: OK"
```

当前 Zen 免费模型的真实 CLI 验收以 Chat Completions 和 Responses 为范围；
Messages 路由已完成网关级实现，但当前没有可验的免费上游模型。手工 curl 与真实
客户端的请求头和请求体可能不同，某一种请求得到的 403 或 500 不能推广为所有
客户端的结论。停止网关后重复同一条 CLI 命令应连接失败，重启后恢复，这可以
确认请求确实经过网关。

## 主要能力

- 三个协议面：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，以及不带
  `/v1` 的兼容别名。
- 免费模型规则：`freeSuffix` 与 `extraFreeIds` 的并集；目录可用且
  `enforceCatalog` 开启时再与在架目录求交集。
- Worker 会话粘滞、故障冷却和有限重试。Responses 的 `previous_response_id` 与
  成功响应的 `response.id` 都参与绑定。
- 每个 Worker 绑定一个直连代理、Clash 桥接代理或本机直连出口；批量探测按 IP
  回显目标的实测公网 IP 分组，真实 Zen 出口需核对上游连接。
- 管理后台提供概览、网关、代理池、Worker、模型、用量六页，以及批量探测和
  订阅刷新。

管理 API 只接受本机回环请求，并要求回环 Host；浏览器 Origin 也必须来自回环
HTTP(S) 地址。凭证只以“是否存在 + 指纹”形式返回。

## 常用命令

```bash
npm start
npm stop
npm run restart
npm run status
npm run doctor
npm run validate
```

`validate` 会先做类型检查，再构建服务端和后台，最后运行全部测试。上游重验
脚本需要网络，单独运行 `npm run discover:upstream`，不会进入本地关卡。

## 文件与安全

- `data/config.json`：配置与凭证，权限为 0600。
- `data/runtime.db`：统计、探测和亲和状态；可删除后重建，不影响配置。
- `data/zen-gateway.log`：脱敏日志，不记录对话正文。
- `opencode.json`、`data/`、`.env*`：不要提交，项目已在 `.gitignore` 中忽略。

管理 API 请求体上限为 1 MiB，转发请求体上限为 64 MiB。上游目录从未成功拉取
过时，`/v1/models` 返回 502 `upstream_unreachable`；目录已拉取但免费集为空
时才返回空的模型列表。自定义 CA、代理出口和 Clash 的排查步骤见
[`docs/usage.md`](docs/usage.md)。

## 文档

- [`docs/usage.md`](docs/usage.md)：安装、配置、API、出口和故障排查。
- [`docs/architecture.md`](docs/architecture.md)：模块边界和请求流程。
- [`docs/upstream-quirks.md`](docs/upstream-quirks.md)：带日期和请求范围的上游观察。
- [`AGENTS.md`](AGENTS.md)：开发约定与验证关卡。
