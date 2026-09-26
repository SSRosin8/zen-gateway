# 安全策略

## 支持范围

只维护 `main` 分支的最新提交，不为旧提交或分叉单独发布修复。

本项目是本机单用户工具：管理面只接受回环请求，网关不提供多租户或对外服务。
把它暴露到公网、局域网或反向代理之后的问题不在支持范围内，但仍欢迎报告能
绕过回环限制、Relay Token 校验或免费模型判定的缺陷。

## 如何报告

请通过 GitHub 的 Private vulnerability reporting 私下报告：
[新建安全报告](https://github.com/SSRosin8/zen-gateway/security/advisories/new)。

不要在公开 issue、PR 或讨论区里描述漏洞细节，也不要粘贴以下内容的原文：

- Zen API key、Relay Token、Clash Controller secret、订阅地址；
- `data/` 下的配置、数据库或日志；
- 真实公网 IP、节点名称、公司网络信息。

复现材料请换成虚构值（例如 `fake-key-not-real`、`203.0.113.9`、`proxy.invalid`）。
如果凭证已经公开，请先自行轮换，再报告。

## 响应预期

这是个人维护的项目，按尽力而为处理：

- 7 天内确认收到；
- 确认问题后在报告中沟通修复计划与时间；
- 修复合入 `main` 后发布安全公告，报告者可选择是否署名。
