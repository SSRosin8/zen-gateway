# zen-gateway

本机单用户的 LM 网关：把 OpenAI 兼容的客户端请求转发到 **OpenCode Zen**，
只放行免费模型，并让多个账号各自走独立的公网出口。

私人自用工具，不做多用户、不做对外服务、不做 provider 抽象（上游锁定 Zen）。

> **当前状态（2026-09-23）**：Phase 0-5 已完成，1094 测试全绿。
> 转发链路与 Worker 调度（分级冷却、会话粘滞、故障轮换）可用；
> 统计、管理后台、订阅解析尚未实现，亲和绑定只在内存里（重启会丢）。
> 详细进度见 [`docs/architecture.md`](docs/architecture.md#实现进度)。

---

## 它解决什么

一个 Zen 账号的用量有限，而多个账号如果从**同一个公网 IP** 发出请求，
上游可以据此把它们关联起来。所以这个网关的核心不是"转发"，而是
**让每个 Worker 绑定各自独立的出口**（HTTP/SOCKS 直连，或经本机 Clash 桥接）。

四件事：

| | 说明 |
|---|---|
| **协议适配** | 可扩展的协议面注册表，多个客户端协议共用同一套鉴权/放行/重试/透传 |
| **免费模型强制** | 只放行 Zen 免费目录里的模型，判定规则由配置驱动而非代码常量 |
| **Worker 调度** | 会话粘滞、故障轮换、分级冷却、加密推理指纹亲和 |
| **出口隔离** | 每 Worker 独立出口，含节点导入、批量探测、按**实测出口 IP** 分组的隔离报告 |

**原样透传**是设计前提：转发出去的是客户端发来的原始字节，不做 JSON 往返
（实测 `{"n":1.0}` → `{"n":1}` 不是无损的）。解析只用于路由判定。

---

## 快速开始

需要 Node 24+（用到 `node:sqlite` 与原生 TS 支持）。

```bash
npm install
npm start          # 构建 → 后台启动 → 健康等待 → 打印 URL
```

首次启动会生成 `data/config.json`（0600 权限）并自动生成 Relay Token。
然后把 OpenCode 指向本网关 —— 在项目或 `~/.config/opencode/opencode.json` 里
**覆盖内置 `opencode` provider**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode": {
      "options": {
        "baseURL": "http://127.0.0.1:9876/v1",
        "apiKey": "<data/config.json 里的 gateway.relayToken>"
      }
    }
  }
}
```

不需要写 `models` 块：内置 provider 自带模型表，手写一份会随上游目录变化而过期。

```bash
opencode run --model opencode/big-pickle "hello"
```

其余命令见 [`docs/usage.md`](docs/usage.md)。

---

## 安全约束

这些是硬要求，每条都有测试守着：

- 管理面**仅 loopback**，且**绝不**把 `X-Forwarded-For` 当作来源证据
- Relay Token 定长比较；空 token 时**拒绝所有请求**（不是放行所有请求）
- `config.json` 0600 + 原子写；`data/` 0700
- API key、代理口令、Clash secret、带 token 的订阅 URL 在所有日志/错误/统计里脱敏
- 上游请求带 `Authorization` 时**不跟随重定向**
- 客户端的 `Authorization`（那是本网关的 Relay Token）绝不转发给上游
- 测试只用明显虚构的 key/IP/域名

`data/`、`opencode.json`、`.env*` 都已在 `.gitignore` 里 —— 它们含凭证。

---

## 文档

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 模块划分、请求流程、七条控制流不变量、实现进度 |
| [`docs/usage.md`](docs/usage.md) | 命令、配置字段、出口绑定、排查 |
| [`docs/upstream-quirks.md`](docs/upstream-quirks.md) | Zen 上游的实测怪癖（带日期与原始响应，可 `npm run discover:upstream` 重验） |
| [`AGENTS.md`](AGENTS.md) | 开发约定（给人与 agent 共用） |
