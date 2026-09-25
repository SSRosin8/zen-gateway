# zen-gateway

本机单用户的 LM 网关：把 OpenAI 兼容的客户端请求转发到 **OpenCode Zen**，
只放行免费模型，并让多个账号各自走独立的公网出口。

私人自用工具，不做多用户、不做对外服务、不做 provider 抽象（上游锁定 Zen）。

> **进度见 [`docs/architecture.md`](docs/architecture.md#实现进度)。**
> 这里刻意不写阶段号与测试数 —— 那些每次提交都在变，而三份文档各存一份
> 副本的结果是它们迟早互相矛盾（第七轮审核时这一段落后了两个阶段，
> 还写着"亲和绑定只在内存里，重启会丢"，而持久化早已交付）。

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
npm run setup      # 可选：自动探测本机 Clash Controller 并导入节点
                   #   它会改写 data/config.json —— 先 `npm run setup -- --dry-run` 看改动
npm run doctor     # 出问题先跑它 —— 分层诊断，只报第一个失败的层
npm run dev        # 管理后台（6 页 + 首启向导），另开一个终端
```

首次启动会生成 `data/config.json`（0600 权限）并自动生成 Relay Token。

> **所在网络对 `opencode.ai` 做 TLS 中间人的话**（内网 DNS + 企业 CA），
> Node 不读系统 CA 库，要改成
> `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start` ——
> 否则症状是 `/v1/models` 返回 **502 `upstream_unreachable`**。
> `npm run doctor` 的第 6 层会直接指出这一条（它查的是**服务进程**的环境变量，
> 不是你当前 shell 的）。别用 `curl` 判断 —— 它读系统 CA，会正常返回 200
> 而网关同时是失败的。原理见 [`docs/usage.md`](docs/usage.md)。

然后把 OpenCode 指向本网关 —— 在项目或 `~/.config/opencode/opencode.json` 里
**覆盖内置 `opencode` provider**：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "opencode": {
      "options": {
        // 端口用 `npm run status` 打印的那个，别照抄
        "baseURL": "http://127.0.0.1:9877/v1",
        "apiKey": "<data/config.json 里的 gateway.relayToken>"
      }
    }
  }
}
```

不需要写 `models` 块：内置 provider 自带模型表，手写一份会随上游目录变化而过期。

```bash
opencode run --model opencode/mimo-v2.6-flash-free "Reply with exactly: OK"
```

验证要用**真实 OpenCode CLI**：免费额度闸门查请求形态不查 key，手搓 `curl`
必然得到 `403 FreeTierError`，那是预期行为而非故障。

其余命令见 [`docs/usage.md`](docs/usage.md)。

---

## 安全约束

这些是硬要求，每条都有能失败的测试守着（第八轮审核用变异逐条确认过 ——
把实现换成朴素版本，对应的断言必须转红）。标 § 的那两条是**源码级**断言：
它们守的性质在行为上不可观测（时序），所以退一步守住产生该性质的实现选择。

- 管理面**仅 loopback**，且**绝不**把 `X-Forwarded-For` 当作来源证据。
  装配期还会断言 `/api/*` 每条路由都被回环闸门覆盖，且按中间件**身份**判定
  ——「挂了某个中间件」不等于「挂的是回环闸门」
- 管理面**绝不回显凭证**：API key / Relay Token / Clash secret / 代理口令只给
  「有没有 + 8 位指纹」。用指纹而不是长度 —— 等长的两个 key 长度相同，
  于是「我改了没生效」在界面上不可见
- 管理面的 JSON 请求体上限 **1 MiB**；转发面 **64 MiB**（为多模态放宽，
  但**不是无界**）—— 两个值刻意不同，见 `admin.ts` 与 `relay.ts` 的常量
- Relay Token **定长比较** §；空 token 时**拒绝所有请求**（不是放行所有请求）
- `config.json` 0600 + **原子写**（临时文件 → fsync → rename）：
  并发读到的永远是完整 JSON，写失败不留残骸也不动原文件；`data/` 0700
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
