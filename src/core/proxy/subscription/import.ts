/**
 * 把解析出来的节点并进配置(纯函数)。
 *
 * 幂等:id = `sub_` + sha256(订阅 id + 节点名) 前 24 位。随机 id 会让 Worker 的 `proxyId`
 * 悬空、实测 `egressIp` 丢失。前缀与 `setup.mjs` 的 `controller_` 不同是刻意的:两个渠道出口路径不同。
 * 身份用 `name` 而非 `host:port`:机场常让多个节点共用入口,折叠会让出口隔离静默失效。
 * 同 id 已存在时只更新连接信息,保留 `enabled` 与 `egressIp`(与 `setup.mjs` 一致)。
 * Clash 未启用时,只能桥接的新节点以停用状态导入并计入 `disabledNeedBridge`:
 * `ConfigSchema` 拒绝已启用的仅桥接代理,否则一次刷新订阅会造出存不下去的配置。
 */

import { createHash } from "node:crypto";
import type { Config, Proxy } from "../../../shared/schema.ts";
import { classifyNode, type ParsedNode } from "./parse.ts";

/** 稳定 id,见文件头。 */
export function subscriptionProxyId(subscriptionId: string, nodeName: string): string {
  const digest = createHash("sha256").update(`${subscriptionId}\u0000${nodeName}`).digest("hex");
  return `sub_${digest.slice(0, 24)}`;
}

export type ImportSummary = {
  readonly added: number;
  readonly updated: number;
  /** 这次订阅里不再出现、因此被移除的节点数。 */
  readonly removed: number;
  /** 因仍被 Worker 引用而未移除的过期节点 id;删掉会破坏引用完整性,所以保留并告知用户。 */
  readonly keptBecauseInUse: readonly string[];
  /** 因「只能桥接而 Clash 未启用」而以停用状态导入的节点数;非 0 时界面要提示。 */
  readonly disabledNeedBridge: number;
  readonly total: number;
};

export type ImportResult = {
  readonly config: Config;
  readonly summary: ImportSummary;
};

/**
 * 把一批节点并进配置。只动 `source: "subscription"` 且 `subscriptionId` 匹配的代理,不碰其他来源。
 */
export function importSubscriptionNodes(
  config: Config,
  subscriptionId: string,
  nodes: readonly ParsedNode[],
): ImportResult {
  const incoming = new Map<string, ParsedNode>();
  for (const node of nodes) {
    // 同名节点重复出现时后者胜,与 Clash 行为一致。
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

    // 只作用于新增;已存在节点的 `enabled` 是用户的编辑。
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
      // 只更新连接信息,`enabled` 与 `egressIp` 保留。
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
