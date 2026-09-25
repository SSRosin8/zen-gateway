/**
 * 把解析出来的节点并进配置 —— **纯函数**。
 *
 * 拉取（`fetch.ts`）与解析（`parse.ts`）都不碰配置；合并的判断集中在这里，
 * 于是"重跑一次订阅会发生什么"可以被穷举测试，而不需要真的去拉一个订阅。
 *
 * ## 幂等：id 从节点身份派生，不是随机的
 *
 * 订阅会被反复刷新（机场换节点、用户点"立即更新"）。如果每次导入都造新 id：
 *
 * - Worker 的 `proxyId` 会指向一个不再存在的代理 → schema 的引用完整性
 *   校验直接拒绝整份配置，网关起不来；
 * - 已实测的 `egressIp` 全部丢失 → 出口隔离报告归零，而那是本项目存在的理由。
 *
 * 所以 id = `sub_` + sha256(订阅 id + 节点身份) 前 24 位。与 `setup.mjs` 的
 * `controller_` 前缀同一个做法（那边是 Controller 导入），前缀不同是刻意的：
 * 同一个节点从两个渠道进来是**两条独立记录**，因为它们的出口路径不同
 * （Controller 导入的走 selector 切换，订阅导入的可能直连）。
 *
 * ## 节点身份用什么
 *
 * 用 `name`，不用 `host:port`。理由是实测的：机场普遍让多个节点共用同一个
 * 入口 IP+端口（靠 SNI/路径区分），于是 `host:port` 会把十几个节点折叠成一个。
 * 而 `name` 在一份订阅内是唯一的（它要显示在客户端的节点列表里）。
 *
 * 代价：机场改了节点名就等于换了节点（旧的被删、新的被加，实测 IP 丢失）。
 * 这个代价是可接受的一侧 —— 反过来（把两个不同节点当成同一个）会让
 * 出口隔离静默失效，而那是不可接受的。
 *
 * ## 保留用户的编辑
 *
 * 同 id 已存在时**只更新连接信息**（host/port/type/凭证），不动
 * `enabled`（用户可能故意停用了某个节点）与 `egressIp`（那是实测事实，
 * 不该因为一次刷新就丢）。这与 `setup.mjs` 的合并规则一致。
 *
 * ## Clash 没开时，只能桥接的节点必须以**停用**状态导入
 *
 * 这条是写测试时被 schema 驳回来才发现的。`ConfigSchema` 有一条
 * `superRefine`：**已启用**且只能桥接的代理，在 `clash.enabled` 为 false 时
 * 是配置矛盾 —— 那条规则是对的（它挡住一个静默失效的配置）。
 *
 * 而订阅里绝大多数节点恰好都是只能桥接的（vless/hysteria2/anytls）。
 * 于是"Clash 没开时导入订阅"会造出一份**存不下去**的配置：`applyConfig`
 * 在 `saveConfig` 那一步被 schema 拒绝，用户看到的是一长串校验错误，
 * 而他只是点了一下"刷新订阅"。
 *
 * 三个选项里选"以停用状态导入"：
 *
 * - *拒绝导入*：Clash 没开时订阅功能完全不可用，而节点信息明明拉到了；
 * - *导入成启用*：配置存不下去（上面那条）；
 * - *导入成停用*：数据留下了，用户开了 Clash 再启用它们。
 *
 * 并且**要在结果里报出来** —— 否则用户会奇怪"为什么导进来的节点全是灰的"。
 */

import { createHash } from "node:crypto";
import type { Config, Proxy } from "../../../shared/schema.ts";
import { classifyNode, type ParsedNode } from "./parse.ts";

/** 稳定 id —— 见文件头。 */
export function subscriptionProxyId(subscriptionId: string, nodeName: string): string {
  const digest = createHash("sha256").update(`${subscriptionId}\u0000${nodeName}`).digest("hex");
  return `sub_${digest.slice(0, 24)}`;
}

export type ImportSummary = {
  readonly added: number;
  readonly updated: number;
  /** 这次订阅里不再出现、因此被移除的节点数。 */
  readonly removed: number;
  /**
   * 因为仍被 Worker 引用而**没有**被移除的过期节点 id。
   *
   * 这不是错误，是一个要告诉用户的事实：他绑了一个订阅里已经消失的节点。
   * 静默删掉会让配置无法通过引用完整性校验（网关起不来）；
   * 静默保留而不说，用户会奇怪"为什么这个节点还在"。
   */
  readonly keptBecauseInUse: readonly string[];
  /**
   * 因为「只能桥接而 Clash 未启用」而被导入成**停用**状态的节点数。
   *
   * 非 0 时界面要提示"开启 Clash 桥接后再启用它们" —— 见文件头。
   */
  readonly disabledNeedBridge: number;
  readonly total: number;
};

export type ImportResult = {
  readonly config: Config;
  readonly summary: ImportSummary;
};

/**
 * 把一批节点并进配置。
 *
 * 只动 `source: "subscription"` 且 `subscriptionId` 匹配的那些 —— 手工添加的
 * 与 Controller 导入的完全不碰。一次订阅刷新不该影响另一个来源的代理。
 */
export function importSubscriptionNodes(
  config: Config,
  subscriptionId: string,
  nodes: readonly ParsedNode[],
): ImportResult {
  const incoming = new Map<string, ParsedNode>();
  for (const node of nodes) {
    // 同名节点在一份订阅里重复出现时后者胜 —— 也就是"最后一次声明"，
    // 与 Clash 自己的行为一致。
    incoming.set(subscriptionProxyId(subscriptionId, node.name), node);
  }

  const boundProxyIds = new Set(
    config.workers.map((w) => w.proxyId).filter((id): id is string => id !== null),
  );

  const mine = (p: Proxy) => p.source === "subscription" && p.subscriptionId === subscriptionId;

  let added = 0;
  let updated = 0;
  let removed = 0;
  let disabledNeedBridge = 0;
  const keptBecauseInUse: string[] = [];

  /*
   * Clash 没开时，只能桥接的新节点导入成停用 —— 见文件头。
   * 已存在的节点不改 `enabled`（那是用户的编辑），所以这只作用于新增。
   */
  const bridgeUnavailable = !config.clash.enabled;

  const next: Proxy[] = [];
  const seen = new Set<string>();

  for (const proxy of config.proxies) {
    if (!mine(proxy)) {
      next.push(proxy);
      continue;
    }

    const node = incoming.get(proxy.id);
    if (node === undefined) {
      // 这个节点这次没出现了。
      if (boundProxyIds.has(proxy.id)) {
        keptBecauseInUse.push(proxy.id);
        next.push(proxy);
      } else {
        removed += 1;
      }
      continue;
    }

    seen.add(proxy.id);
    const { direct, bridgeable } = classifyNode(node.type);
    next.push({
      ...proxy,
      // 只更新连接信息 —— `enabled` 与 `egressIp` 保留，见文件头。
      name: node.name,
      type: node.type,
      host: node.host,
      port: node.port,
      ...(node.username === undefined ? {} : { username: node.username }),
      ...(node.password === undefined ? {} : { password: node.password }),
      direct,
      bridgeable,
      clashNodeName: node.name,
    });
    updated += 1;
  }

  for (const [id, node] of incoming) {
    if (seen.has(id)) continue;
    const { direct, bridgeable } = classifyNode(node.type);
    const needsBridge = !direct && bridgeable;
    const enabled = !(needsBridge && bridgeUnavailable);
    if (!enabled) disabledNeedBridge += 1;
    next.push({
      id,
      name: node.name,
      type: node.type,
      host: node.host,
      port: node.port,
      ...(node.username === undefined ? {} : { username: node.username }),
      ...(node.password === undefined ? {} : { password: node.password }),
      enabled,
      source: "subscription",
      subscriptionId,
      direct,
      bridgeable,
      clashNodeName: node.name,
      egressIp: null,
    });
    added += 1;
  }

  return {
    config: { ...config, proxies: next },
    summary: {
      added,
      updated,
      removed,
      keptBecauseInUse,
      disabledNeedBridge,
      total: incoming.size,
    },
  };
}
