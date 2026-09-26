# 出口排查细节

SKILL.md 七条检查的展开。`npm run doctor` 的分层写在 `scripts/doctor.mjs`，各层判定在
`scripts/lib/doctor/`，改动以源码为准。

## 1. 自定义 CA

企业网络可能改写 DNS 与证书链，服务进程的信任库与交互式 shell 不同。修法：

```bash
NODE_EXTRA_CA_CERTS=/path/to/your/ca-bundle.pem npm start
```

doctor 的目录层经服务请求 `GET /v1/models`，并读 `/proc/<pid>/environ` 核对服务
进程自己的环境变量。症状是 502 `upstream_unreachable`；"200 加空列表"是另一种情况：
目录拉到了而免费子集为空。

## 2. `GLOBAL` 分组

`mode: rule` 下 `GLOBAL` 可能不参与选路，把它当 `selectorGroup` 时切换请求成功、
`now` 却仍是 `DIRECT`，所有 Worker 共用一个公网 IP 且不报错。

`setup.mjs` 读取 `/rules`，优先选 MATCH 兜底指向且含可出口节点的分组；拿不到规则
时按模式、名称与节点数择优。doctor 第 5 层（`scripts/lib/doctor/clash.mjs`）用 `ClashController.routedGroups()` 检查
所选分组是否参与规则、是否承接兜底。

## 3. 混合端口

`mixed-port` 随内核而变，`port` / `socks-port` 可能都是 0。配置的 `localProxyPort`
与内核实际监听不一致时，所有桥接代理传输失败而控制面正常。

doctor 核对内核报告的 `mixed-port` 与配置；内核没有报告有效值时，这项比较不能证明
端口正确。`setup.mjs` 只接受有效的 `mixed-port`，不退回 `socks-port` 或 `port`，
未开启混合端口时拒绝导入。bridge 模式总是建 `http://host:port` 的 ProxyAgent。

## 4. 未探测

写 `proxies[].egressIp` 的只有 `POST /api/probe`（概览页按钮）与批量探测（代理池页），
两者都经 `applyProbeResults`（`src/core/proxy/egress.ts`）。报告为空时先确认是否
执行过探测、服务是否写回了配置，再怀疑分组逻辑。

## 5. 按实测 IP 分组

两个代理可能 NAT 到同一个公网 IP。直连出口（`proxyId: null`）也参与：
`applyProbeResults` 把合成 id `DIRECT_EGRESS_ID` 的测量写入
`gateway.directEgressIp`，代理测量写入 `proxies[].egressIp`。失败保留最后一次成功值，
不代表该出口现在仍可用。

## 6. 探测目标与转发目标

探测优先打 `api.ipify.org`，失败时回退其他回显服务；转发打 `opencode.ai`。
两者、以及不同回显服务之间都可能命中不同规则，诊断保留实际成功服务的 `via`。
测量范围见 [`docs/usage.md`](../../../docs/usage.md#回显-ip-的测量范围)。

企业 DNS 把 `opencode.ai` 解析到私网地址时，排在分组规则前的私网
`IPCIDR → DIRECT` 先命中，所有 Worker 的 Zen 请求直连。`/connections` 里表现为
`chains` 只有 `DIRECT`、`rule` 为 `IPCIDR`。修法是把
`DOMAIN-SUFFIX,opencode.ai,<分组>` 放到规则最前，并写在订阅更新后仍保留的位置
（客户端的规则扩展或 prepend），不直接改生成的运行配置。见
[`docs/usage.md`](../../../docs/usage.md#出口和-clash)。

连接匹配：用网关进程到混合端口的 socket 源端口，对照连接记录 metadata 的源端口；
必要时结合创建时间、目标端口，并一次只跑一个 CLI 请求。

## 7. 多内核

doctor 报本次探活的择优结果、可用节点数和理由（`clash/select.ts`），但它是只读的，
不写回选择。实际转发按配置的 `activeBridgeId` 与 `resolveProxy` 解析，批测择优时
才写回切换结果。

- manual 模式不自动切换：悄悄换会让"我选了这个内核"变成无从察觉的偏差。
- auto 模式有粘滞：当前可用就不换，哪怕别的 `priority` 更小；换内核会换端口并重建
  全部 dispatcher。
- 能连上但 selector 分组里没节点算不可用：分组名写错时控制面正常而每个桥接都失败。
- 全部不可用时保留 `activeBridgeId`，不把短暂故障变成抹掉用户选择。
- 批测期间锁定单内核：中途换内核会让隔离报告混入两个内核的出口。

## 常用命令

```bash
npm run doctor                 # 分层，只报第一个失败的层
npm run doctor -- --deep       # 实测公网 IP（会切 Clash 节点）
npm run setup -- --help        # setup 参数；--api 只接受本机回环 HTTP 地址
curl -s 127.0.0.1:<port>/api/overview   # 就绪态、冷却剩余、隔离报告
```
