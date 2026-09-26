---
name: debug-egress
description: 出口隔离异常、代理桥接失败、Clash 分组切换不生效、模型目录缺失或模型接口返回 502 时使用。按依赖顺序检查配置、服务、Worker、控制面、目录和出口，核对信任库、实际代理端口、规则分组与真实转发链路，不把某台机器的观察当作通用默认值。
---

# 排查出口与桥接

**先跑 `npm run doctor`。** 它按依赖顺序分七层，**只报第一个失败的层** ——
后面的层在它修好之前给不出有意义的答案。加 `--deep` 会实测 IP 回显目标的公网出口
（会真发请求并切 Clash 节点），测量范围见第 6 节。

下面是常见且可复核的陷阱，按排查顺序列出。

## 1. 自定义 CA 或信任库 —— 症状是 `/v1/models` 返回 502

某些企业网络会改写上游 DNS 和证书链，服务进程的信任库可能与交互式 shell 不同。

**关键的不对称：`curl` 能过，Node 不能。** curl 与 Node 可能使用不同信任库。
显式启用额外 CA 后行为会不同。

所以「我 curl 验过上游是通的」对网关**完全不成立**（纪律 #8）。修法：

```bash
NODE_EXTRA_CA_CERTS=/path/to/your/ca-bundle.pem npm start
```

**症状是 502 `upstream_unreachable`，不是"200 加空列表"。**
（后者是另一种情况：目录拉到了而免费子集为空。）

`npm run doctor` 第 6 层会直接指出来 —— 它查的是**服务进程**的环境变量
（读 `/proc/<pid>/environ`），不是你当前 shell 的。两者可以不同。

## 2. `GLOBAL` 分组在 rule 模式下切了不生效

在 `mode: rule` 下，`GLOBAL` 分组可能不参与选路。
把它当 selectorGroup 会让所有 Worker 共用一个公网 IP，而**不报任何错** ——
切换请求成功返回，`now` 却仍是 `DIRECT`。

`setup.mjs` 已读取 `/rules`，优先选择 MATCH 兜底指向、且含可出口节点的分组。
拿不到规则时才退回按模式、名称与节点数择优。`doctor.mjs` 通过
`ClashController.routedGroups()` 检查所选分组是否参与规则、是否承接兜底。

`npm run doctor -- --deep` 按实测 IP 分组，可以发现探测链路的共用出口。
探测和真实转发可能命中不同规则，仍需按第 6 节核对实际连接。

## 3. `mixed-port` 与配置不一致 —— 控制面通而数据面全挂

混合端口不是稳定的文档默认值，且随内核而变；`port`/`socks-port` 还可能都是 0。

配置里的 `localProxyPort` 与内核实际监听的不一致时，桥接会连到一个
**没人监听的端口**：所有桥接代理传输失败，而控制面明明是通的。
那是个极难自查的故障 —— 所以端口**只能问内核**（`GET /configs`）。

doctor 第 5 层会核对内核报告的 `mixed-port` 与配置是否一致；内核没有报告有效值时，
该项比较不能证明端口正确。`setup.mjs` 只接受有效的 `mixed-port`，不会退回
`socks-port` 或 `port`，未开启混合端口时会拒绝导入。

`localProxyPort` 不能指向 SOCKS 专用端口：bridge 模式总是建
`http://host:port` 的 ProxyAgent，发的是 HTTP `CONNECT`，不是 SOCKS 握手。

## 4. 回显出口视图显示「未探测」

**只有两个地方会写 `config.proxies[].egressIp`**：`POST /api/probe`
（概览页那个按钮）与批量探测（代理池页）。两者都经 `applyProbeResults`。

回显出口报告在它们跑过之前**没有数据来源** —— 概览页会显示"未探测"
而不是报错。看到空的隔离视图先想到这一条，别去怀疑分组逻辑。

> 如果报告为空，先确认是否已经执行过探测，以及服务是否成功写回配置。

## 5. 回显出口按**实测 IP** 分组，不按代理 id

两个不同代理可能 NAT 到同一个公网 IP，代理 id 不同不等于出口不同。
**未探测出 IP 的不能判为独立回显出口**。

直连出口（`proxyId: null`）也要参与：它与某个代理 NAT 到同一个 IP 恰好是
"代理不同但回显出口共用"的形态。`applyProbeResults` 将合成 id
`DIRECT_EGRESS_ID` 对应的测量写入 `gateway.directEgressIp`，代理测量写入
`proxies[].egressIp`；失败保留最后一次成功值，不代表该出口目前仍然可用。

## 6. 探测目标与转发目标不同域

探测优先打 `api.ipify.org`（失败时回退其他 IP 回显服务），转发打 `opencode.ai`，
两者可能命中不同的路由规则，完整说明见 `docs/usage.md` 的“回显 IP 的测量范围”。
不同回显服务间也可能命中不同规则，诊断时保留实际成功服务 `via`。

企业 DNS 可能把 `opencode.ai` 解析到内网地址，排在分组规则之前的私网
`IPCIDR → DIRECT` 于是先命中，所有 Worker 的 Zen 请求直连。doctor 第 5 层用
`upstreamRoute` 按规则顺序判定首条命中并告警；`/connections` 里表现为 `chains`
只有 `DIRECT`、`rule` 为 `IPCIDR`。

验收时在真实 CLI 请求期间读 `/connections`，核对目标为 `opencode.ai` 的连接、
`chains` 与命中的 `rule`。

同域名可能同时有其他应用请求。用网关进程到混合端口的 socket 源端口与连接记录中
metadata 的源端口字段匹配，必要时结合创建时间、目标端口和一次只跑一个 CLI 请求，
避免把别的连接当作本次网关请求。短请求未被采到时记为"没有捕获到选路证据"，
不能推断其走代理或直连。

若需改规则或启用独立内核验证，先整理可核对的配置变更范围；不在排查过程中静默
改动用户正在使用的 Clash 模式、规则或全部连接。测试结果只记录匿名化的出口标签、
命中情况、HTTP 状态和模型结果，不保存节点原名、真实 IP 或凭证。

## 7. 多内核：现在到底走哪个

`npm run doctor` 第 5 层会报本次探活的择优结果、可用节点数和理由
（`clash/select.ts`）。doctor 是只读工具，不会写回选择；实际转发按配置的
`activeBridgeId` 与 `resolveProxy` 解析，批测择优时才会把切换结果写回。

几条容易误解的行为：

- **manual 模式绝不自动切换**。选中的内核挂了就是挂了，doctor 会报原因
  但网关不会换 —— 悄悄换会让"我明明选了这个内核"变成无从察觉的偏差。
- **auto 模式有粘滞**：当前内核仍可用就不换，哪怕别的 `priority` 更小。
  换内核意味着换端口 → dispatcher 全部重建，而会话亲和的语义会变。
- **「连得上但 selector 分组里没节点」算不可用**。`selectorGroup` 名字写错
  或分组被改过时，Controller 答得好好的而每个桥接代理都失败。
- **全部不可用时保留 `activeBridgeId`** 不清空 —— 那会把"Clash 挂了一分钟"
  变成"用户的内核选择被抹掉"。
- **批测期间锁定单内核**（protocol-surface 第 5 条不变量的延伸）：一批探测跑到一半换了内核，
  后半批量到的是另一个内核的出口，而隔离报告把两批混在一起按 IP 分组。

## 本机状态只从运行环境读取

内核地址、端口、secret、启用状态与分组会随本机配置改变，不在 skill 中保存副本。
凭证只保存在本机配置；排查结果不输出原值。`setup --api` 仅接受本机 HTTP
回环地址，实际使用以 `npm run setup -- --help` 与 doctor 输出为准。

## 排查顺序小结

```bash
npm run doctor                 # 分层，只报第一个失败的层
npm run doctor -- --deep       # 实测公网 IP（会切 Clash 节点）
curl -s 127.0.0.1:<port>/api/overview   # 就绪态、冷却剩余、隔离报告
```

端口用 `npm run status` 打印的那个，**别照抄文档里的数字**。
