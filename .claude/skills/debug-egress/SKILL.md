---
name: debug-egress
description: 出口隔离异常、代理桥接失败、Clash 分组切换不生效、模型目录缺失或模型接口返回 502 时使用。按依赖顺序检查配置、服务、统计库、Worker、控制面、目录和出口，核对信任库、实际代理端口、规则分组与真实转发链路，不把某台机器的观察当作通用默认值。
---

# 排查出口与桥接

**先跑 `npm run doctor`。** 它按依赖顺序分七层，**只报第一个失败的层** ——
后面的层在它修好之前给不出有意义的答案。加 `--deep` 会实测每个出口的公网 IP
（会真发请求并切 Clash 节点）。

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
（后者是另一种情况：目录拉到了而免费子集为空。这条记错过一次，
而错的版本在三份文档里互相印证了一整个阶段。）

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

doctor 第 5 层会核对。**注意一个已登记的盲区**：它只读 `mixed-port`，
而 `setup.mjs` 在 `mixed-port` 为 0 时会退回 `socks-port`/`port` ——
那种内核上这项检查看不见不一致。且 `localProxyPort` 指向一个 **socks** 端口
时桥接根本不能用：bridge 模式总是建 `http://host:port` 的 ProxyAgent
（实测发的是 `CONNECT`，从不发 SOCKS 握手）。

## 4. 隔离视图显示「还不知道」

**只有两个地方会写 `config.proxies[].egressIp`**：`POST /api/probe`
（概览页那个按钮）与批量探测（代理池页）。两者都经 `applyProbeResult`。

出口隔离报告在它们跑过之前**没有数据来源** —— 概览页会显示"还不知道"
而不是报错。看到空的隔离视图先想到这一条，别去怀疑分组逻辑。

> 如果报告为空，先确认是否已经执行过探测，以及服务是否成功写回配置。

## 5. 隔离判定按**实测 IP** 分组，不按代理 id

两个不同代理可能 NAT 到同一个公网 IP，那种情况下"已隔离"是假的。
**未探测出 IP 的不算已隔离** ——「不知道」不等于「不同」。

直连出口（`proxyId: null`）也要参与：它与某个代理 NAT 到同一个 IP 恰好是
"看起来隔离其实没隔离"的形态。`applyProbeResults` 将合成 id
`DIRECT_EGRESS_ID` 对应的测量写入 `gateway.directEgressIp`，代理测量写入
`proxies[].egressIp`；失败保留最后一次成功值，不代表该出口目前仍然可用。

## 6. 探测目标与转发目标不同域

探测打 `api.ipify.org` 而转发打 `opencode.ai` —— 两者可能命中**不同的
路由规则**，于是测出的"出口不同"与实际转发无关。本项目真实踩到过：
探测可能走代理而转发命中另一条规则。

证明"流量走了哪个出口"的可靠办法是读 Clash 的 `/connections`
（直接给 `chains` 与命中的 `rule`）。

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
- **批测期间锁定单内核**（不变量 #5 的延伸）：一批探测跑到一半换了内核，
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
