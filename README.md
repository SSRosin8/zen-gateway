# zen-gateway

zen-gateway 是一个运行在本机的 OpenCode Zen 网关。它接收 OpenAI 兼容的
Chat Completions、Responses，以及 Anthropic Messages 请求，只放行配置为免费
模型的请求，并按 Worker 选择配置的直连或 Clash 出口。

这是单用户工具：上游固定为 Zen，网关只监听本机回环地址，管理后台可在设置访问口令后
开放给局域网；不提供多租户或对外服务。请求体按原始字节转发，网关只解析路由、模型和流式事件所需的字段。

## 快速开始

需要 Node.js 24 或更高版本。一条命令启动网关与管理后台：

```bash
npm install
npm start         # 构建并启动；管理后台 http://127.0.0.1:5173
npm run open      # 可选：用浏览器打开管理后台
```

网关端口（默认 9876）只提供 `/health`、`/v1/*`、无前缀协议别名和 `/api/*`；管理后台
在独立端口（默认 5173）上，由同一个进程伺服构建产物。设置访问口令后可从局域网访问后台。
完整说明见 [`docs/usage.md`](docs/usage.md#安装和运行)。

首次启动会创建 `data/config.json` 并生成 Relay Token。管理后台的 Worker 页可
新增、编辑和删除 Worker；认证 Worker 填 Zen API key，匿名 Worker 不发送任何
上游凭证。手工 HTTP / SOCKS 代理可以在出口页新增和编辑；Clash 内核与节点可以在
出口页导入、手工写入配置，也可以用 `npm run setup` 探测本机 Controller：

```bash
npm run setup -- --dry-run
npm run setup
npm run restart
npm run doctor
```

`setup` 写入后必须重启；重启前不要在后台保存配置，原因见
[`docs/usage.md`](docs/usage.md#导入-clash-出口)。

## 配置 OpenCode

先运行 `npm run status` 查看网关实际端口，再按
[`docs/usage.md`](docs/usage.md#客户端接入) 的 OpenCode 1.x/2.x 示例替换端口和
Relay Token；后台客户端接入页也能生成对应片段。两种格式都只覆盖 Base URL 和 API Key，
模型与 SDK 继续由 OpenCode 自己管理。

```bash
opencode run --model opencode/big-pickle "Reply with exactly: OK"
```

验收要用真实 CLI 和“停网关即失败、重启即恢复”的控制实验，方法见
[`docs/usage.md`](docs/usage.md#客户端验收)。

## 主要能力

- 三个协议面：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，以及不带
  `/v1` 的兼容别名。
- 免费模型规则：`freeSuffix` 与 `extraFreeIds` 的并集；目录可用且
  `enforceCatalog` 开启时再与在架目录求交集。
- Worker 会话粘滞、故障冷却和有限重试。Responses 的 `previous_response_id` 与
  成功响应的 `response.id` 都参与绑定。
- 每个 Worker 绑定一个直连代理、Clash 桥接代理或本机直连出口；批量探测按 IP
  回显目标的实测公网 IP 分组（[测量范围](docs/usage.md#回显-ip-的测量范围)）。
- 管理后台（桌面浏览器）提供快速开始、概览、Worker、出口、客户端接入、网关、模型、用量和诊断页，
  覆盖 CLI 的配置、探测（逐个或批量）、订阅刷新与诊断。

管理 API 只接受本机回环请求，并要求回环 Host；浏览器 Origin 也必须来自回环
HTTP(S) 地址。开启局域网访问后，带有效口令会话、Host 为私网 IP 且 Origin 同源的
请求也放行（见 [局域网访问](docs/usage.md#局域网访问)）。凭证只以“是否存在 + 指纹”形式返回。

## 常用命令

```bash
npm start
npm stop
npm run restart
npm run status
npm run doctor
npm run validate
```

`validate` 是本地完整关卡（见 [`AGENTS.md`](AGENTS.md#开发与验证)）；需要网络的
`npm run discover:upstream` 单独运行。

## 文件与安全

- `data/config.json`：配置与凭证，权限为 0600。
- `data/runtime.db`：统计、探测和亲和状态；可删除后重建，不影响配置。
- `data/zen-gateway.log`：脱敏日志，不记录对话正文。
- `opencode.json`、`data/`、`.env*`：不要提交，项目已在 `.gitignore` 中忽略。

自定义 CA、代理出口和 Clash 的排查步骤见 [`docs/usage.md`](docs/usage.md)。

## 文档

- [`docs/usage.md`](docs/usage.md)：安装、配置、API、出口和故障排查。
- [`docs/requirements.md`](docs/requirements.md)：功能边界与验收矩阵。
- [`docs/architecture.md`](docs/architecture.md)：模块边界和请求流程。
- [`docs/upstream-quirks.md`](docs/upstream-quirks.md)：带日期和请求范围的上游观察。
- [`AGENTS.md`](AGENTS.md)：开发约定与验证关卡。
- [`CONTRIBUTING.md`](CONTRIBUTING.md)：贡献流程；安全问题按 [`SECURITY.md`](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。
