# zen-gateway 工作入口

这是一个本机单用户的 OpenCode Zen 网关。开始工作前先阅读：

1. [`AGENTS.md`](AGENTS.md)：开发约定、验证关卡和安全纪律。
2. [`README.md`](README.md)：项目用途、启动和客户端接入。
3. [`docs/requirements.md`](docs/requirements.md)：功能边界与验收矩阵。
4. [`docs/architecture.md`](docs/architecture.md)：模块与请求流程。
5. [`docs/usage.md`](docs/usage.md)：配置、管理 API、出口和排查。
6. [`docs/upstream-quirks.md`](docs/upstream-quirks.md)：有测量范围的上游观察。

代码变更完成后运行 `npm run validate`。不要提交 `data/`、`opencode.json`、真实
凭证或 `.env*` 文件。
