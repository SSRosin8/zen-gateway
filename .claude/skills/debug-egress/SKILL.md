---
name: debug-egress
description: Use when egress isolation looks wrong, a bridged proxy fails, Clash selector switching misbehaves, the model catalog is empty, or /v1/models returns 502. Encodes the measured traps on this machine — the corporate CA interception, the GLOBAL selector trap, the mixed-port trap — and the order to check them in. Trigger on 出口, 隔离, Clash, 桥接, selector, 探测, 502, 目录拉不到, egress, bridge, proxy fails, CA.
---

# 排查出口与桥接

**先跑 `npm run doctor`。** 它按依赖顺序分七层，**只报第一个失败的层** ——
后面的层在它修好之前给不出有意义的答案。加 `--deep` 会实测每个出口的公网 IP
（会真发请求并切 Clash 节点）。

下面是这台机器上**实测过**的陷阱，按发生频率排。

## 1. 企业 CA 中间人 —— 症状是 `/v1/models` 返回 502

本机 `opencode.ai` 被内网 DNS 解析到内网地址，证书由小米企业 CA 签发。

**关键的不对称：`curl` 能过，Node 不能。** curl 读系统 CA 库
（`/etc/ssl/certs/ca-certificates.crt`，已含该 CA），而 **Node 用编译进
二进制的 CA 集合，不读系统库**。

所以「我 curl 验过上游是通的」对网关**完全不成立**（纪律 #8）。修法：

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm start
```

**症状是 502 `upstream_unreachable`，不是"200 加空列表"。**
（后者是另一种情况：目录拉到了而免费子集为空。这条记错过一次，
而错的版本在三份文档里互相印证了一整个阶段。）

`npm run doctor` 第 6 层会直接指出来 —— 它查的是**服务进程**的环境变量
（读 `/proc/<pid>/environ`），不是你当前 shell 的。两者可以不同。

## 2. `GLOBAL` 分组在 rule 模式下切了不生效

本机 Clash Verge 是 `mode: rule`，而 **rule 模式下 `GLOBAL` 分组不参与选路**。
把它当 selectorGroup 会让所有 Worker 共用一个公网 IP，而**不报任何错** ——
切换请求成功返回，`now` 却仍是 `DIRECT`。

`setup.mjs` 已按 `mode` 把 GLOBAL 降级（只在没有别的候选时用它并告警）。
**但那是启发式不是守卫**：一个名字不叫 GLOBAL 却同样不参与选路的分组仍会
被选中。真正的判据是"规则实际把流量导向哪个分组"，那要解析 `/configs` 的
rules —— 眼下不做。

**兜底手段是 `npm run doctor -- --deep`**：它按实测公网 IP 分组，
共用出口一定会被报出来。

## 3. `mixed-port` 与配置不一致 —— 控制面通而数据面全挂

本机混合端口**不是**文档默认的 7890，且随内核而变（0dcloud 是 17891，
Clash Verge 是 7897），`port`/`socks-port` 还可能都是 0。

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

> 这个缺口是 Phase 9 接后台时才暴露的：`applyProbeResult()` 零生产调用点，
> 而七轮审核都没查到 —— 每一层单独看都是对的（纯函数有单测、探测真在跑、
> 分组逻辑有测试），缺的是把它们接起来的那根线。

## 5. 隔离判定按**实测 IP** 分组，不按代理 id

两个不同代理可能 NAT 到同一个公网 IP，那种情况下"已隔离"是假的。
**未探测出 IP 的不算已隔离** ——「不知道」不等于「不同」。

直连出口（`proxyId: null`）也要参与：它与某个代理 NAT 到同一个 IP 恰好是
"看起来隔离其实没隔离"的形态。**但它的探测结果结构上存不下来**
（映射到合成 id `__direct__`，而 `config.proxies` 里没有这一行）——
已登记为缺口 #28。

## 6. 探测目标与转发目标不同域

探测打 `api.ipify.org` 而转发打 `opencode.ai` —— 两者可能命中**不同的
路由规则**，于是测出的"出口不同"与实际转发无关。本项目真实踩到过：
探测走代理而转发因内网劫持走 DIRECT。

证明"流量走了哪个出口"的可靠办法是读 Clash 的 `/connections`
（直接给 `chains` 与命中的 `rule`）。

## 7. 多内核：现在到底走哪个

`npm run doctor` 第 5 层会报**择优结果**（`当前走 <bridgeId>` + 每个内核的
可用节点数 + 理由），判据与转发路径同一份逻辑（`clash/select.ts`）。

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

## 本机当前状态（会变，用 doctor 复核）

Clash Verge：`127.0.0.1:9097`，secret `123.`，mixed-port 7897，
`mode: rule`，selectorGroup `Proxy`。0dcloud 那个内核因**控制面 401 进不去**
而 `enabled: false` —— 保留而非删除，等拿到密码可直接启用。

## 排查顺序小结

```bash
npm run doctor                 # 分层，只报第一个失败的层
npm run doctor -- --deep       # 实测公网 IP（会切 Clash 节点）
curl -s 127.0.0.1:<port>/api/overview   # 就绪态、冷却剩余、隔离报告
```

端口用 `npm run status` 打印的那个，**别照抄文档里的数字**。
