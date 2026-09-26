# 贡献指南

欢迎提交缺陷报告、文档修正和改进。开发约定、验证关卡和十三条纪律以
[`AGENTS.md`](AGENTS.md) 为唯一来源，本文只列出提交流程。

## 环境

- Node.js 24 或更高版本；
- `npm ci` 安装依赖，测试不需要真实上游凭证或网络。

## 流程

1. Fork 仓库，从 `main` 建描述任务的功能分支。
2. 修改代码或文档，同步 `docs/` 中受影响的说明与需求矩阵。
3. 运行 `npm run validate`，它包含敏感文件检查、类型检查、构建和全部测试；
   CI 在 PR 上运行同一命令，未通过不能合入。
4. 提交信息使用前缀：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`，
   正文写改动原因、验证范围和剩余限制。
5. 提交 PR，按模板勾选检查清单。

## 隐私样例

测试、文档和 issue 只用明显虚构的值：凭证写 `fake-key-not-real`，IP 用
`203.0.113.9` 这类文档保留地址，域名用 `proxy.invalid`。不要复制真实节点名、
订阅地址、个人主目录路径、公司网络信息或日志原文。`npm run check:sensitive`
会扫描常见凭证格式、个人路径、邮箱和公网 IP，但它只是兜底。

建议在 GitHub 的邮箱设置中开启 “Keep my email addresses private”，并把本地
`git config user.email` 设为 `<id>+<用户名>@users.noreply.github.com`，避免提交
元数据暴露私人邮箱。

## AI 协作

- 使用 AI 工具时同样遵循 `AGENTS.md`；AI 生成的代码由提交者负责，提交前要读懂
  并验证。
- 建议提交前在 Claude Code 中运行 `/code-review` 与 `/security-review`。
- 不直接引入第三方 skill。`.claude/` 下的改动会影响所有使用该目录的 AI 工具，
  评审时会重点审阅，PR 中请说明原因。

## 许可证

本项目以 [MIT](LICENSE) 许可证发布。提交贡献即表示你同意贡献内容以同一许可证
发布（inbound = outbound）。
