---
name: debug-egress
description: 排查 zen-gateway 的出口隔离、Clash 桥接和上游连通问题。在代理桥接失败、Clash 分组切换不生效、回显出口显示未探测、模型目录缺失或 `/v1/models` 返回 502 时使用；按依赖顺序定位第一个失败层，并核对服务进程的信任库、内核实际端口和真实转发链路。
---

# 排查出口与桥接

先跑 `npm run doctor`：它按依赖顺序分层，只报第一个失败的层，后面的层在它修好前
没有意义。`npm run doctor -- --deep` 会真发请求并切换 Clash 节点，实测 IP 回显
目标的公网出口。结论只覆盖被测的目标（纪律 #6/#8）。

## 按顺序检查

1. 自定义 CA：`/v1/models` 返回 502 `upstream_unreachable`。这不是"200 加空列表"，
   后者是另一种情况（目录拉到了而免费子集为空）。curl 能过不代表 Node 能过；
   doctor 读的是服务进程的 `NODE_EXTRA_CA_CERTS`，不是当前 shell。
2. `GLOBAL` 分组在 `mode: rule` 下可能不参与选路：切换成功返回，所有 Worker 却共用
   一个出口。`ClashController.routedGroups()` 判断分组是否承接规则兜底。
3. `mixed-port` 与 `localProxyPort` 不一致：控制面通、数据面全挂。端口只以内核
   `GET /configs` 为准；bridge 发 HTTP `CONNECT`，不能指向 SOCKS 专用端口。
4. 回显出口显示"未探测"：只有 `POST /api/probe` 与批量探测经 `applyProbeResults`
   写回 `egressIp`，没跑过就没有数据；后台改过手工代理的连接信息后也会回到未探测。
5. 出口按实测 IP 分组而不是代理 id；未测出 IP 的不能判为独立出口。直连出口用
   `DIRECT_EGRESS_ID` 参与比较。
6. 探测目标与转发目标不同域，可能命中不同规则。企业 DNS 把 `opencode.ai` 解析到
   私网时，`upstreamRoute` 会报 `IPCIDR → DIRECT` 先命中。
7. 多内核：manual 模式不自动切换；auto 模式当前可用就不换；selector 分组里没有
   节点算不可用；全部不可用时保留 `activeBridgeId`。

每一条的症状、原因和修法见 [reference.md](reference.md)。

## 验收真实转发链路

在真实 CLI 请求期间读 Clash `/connections`，核对目标为 `opencode.ai` 的连接的
`chains` 与命中 `rule`。同域名可能有其他应用的连接，用源端口匹配；没采到时记为
"没有捕获到选路证据"，不推断走代理或直连。

## 边界

- 不在排查中静默修改用户正在使用的 Clash 模式、规则或连接；先列出变更范围。
- 内核地址、端口、secret 与分组只从运行环境读取，不写进 skill 或文档。
- 结果只记录匿名化出口标签、HTTP 状态和模型结果，不保存节点原名、真实 IP 或凭证。
- 端口用 `npm run status` 打印的值，不照抄文档里的数字。
