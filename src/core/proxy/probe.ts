import { fetch, type Dispatcher } from "undici";
import { canonicalizeIp, isIpAddress } from "../../shared/ip.ts";
import type { FailureKind } from "../failures.ts";
import { classifyError, classifyStatus } from "../failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { elapsedMs } from "../../shared/elapsed.ts";
import type { SelectorLock } from "./selectorLock.ts";
import type { ClashController } from "./clash/controller.ts";

/**
 * 出口探测(数据面):实测发往 IP 回显目标这条链路的公网出口 IP。
 *
 * 不用 Controller `/delay` 代替:那是 Clash 自己连测试 URL,不证明我们的流量从该节点出去。
 * 回显结果只描述该目标命中的路由,不能单独证明发往 Zen 的请求使用相同出口(纪律 #6)。
 */

/** IP 回显服务。多个候选依次回退,单一服务挂掉或被墙不致整个探测失效;只取 IP。 */
export type IpEchoService = {
  url: string;
  /** 从响应文本里取出 IP;取不到返回 null。 */
  extract(text: string): string | null;
};

const asPlainText = (text: string): string | null => {
  const trimmed = text.trim();
  return isIpAddress(trimmed) ? trimmed : null;
};

const asJsonField = (field: string) => (text: string): string | null => {
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[field];
    return typeof value === "string" && isIpAddress(value.trim()) ? value.trim() : null;
  } catch {
    return null;
  }
};

export const DEFAULT_IP_ECHO_SERVICES: IpEchoService[] = [
  { url: "https://api.ipify.org", extract: asPlainText },
  { url: "https://ifconfig.me/ip", extract: asPlainText },
  { url: "https://api.ip.sb/ip", extract: asPlainText },
  { url: "https://httpbin.org/ip", extract: asJsonField("origin") },
];

export type ProbeOutcome =
  | {
      ok: true;
      egressIp: string;
      latencyMs: number;
      /** 实际回显成功的服务,便于诊断「是不是某个服务挂了」。 */
      via: string;
    }
  | {
      ok: false;
      failureKind: FailureKind;
      /** 已脱敏的原因,可直接进日志与 UI。 */
      reason: string;
    };

export type ProbeRequest = {
  dispatcher: Dispatcher;
  /** 桥接模式必须提供:切 selector 与建连接要在同一把锁内。 */
  bridge?: {
    lock: SelectorLock;
    controller: ClashController;
    selectorGroup: string;
    nodeName: string;
  };
  services?: IpEchoService[];
  /** 单个回显服务的超时。 */
  timeoutMs?: number;
  now?: () => number;
};

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * 探测一条出口链路的公网 IP。
 * 桥接模式下「切 selector + 直到响应头到达」在锁内,读体在锁外,与 SelectorLock 的边界一致。
 */
export async function probeEgress(req: ProbeRequest): Promise<ProbeOutcome> {
  const services = req.services ?? DEFAULT_IP_ECHO_SERVICES;
  const timeoutMs = req.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const now = req.now ?? Date.now;

  if (services.length === 0) {
    return { ok: false, failureKind: "unknown", reason: "没有可用的 IP 回显服务" };
  }

  let lastFailure: ProbeOutcome & { ok: false } = {
    ok: false,
    failureKind: "unknown",
    reason: "未执行任何探测",
  };

  for (const service of services) {
    const started = now();

    let response: Response;
    try {
      // 桥接:切 selector 与建立连接必须原子。
      response = req.bridge
        ? await req.bridge.lock.run(async () => {
            await req.bridge!.controller.select(req.bridge!.selectorGroup, req.bridge!.nodeName);
            return fetchThrough(service.url, req.dispatcher, timeoutMs);
          })
        : await fetchThrough(service.url, req.dispatcher, timeoutMs);
    } catch (err) {
      lastFailure = {
        ok: false,
        failureKind: classifyError(err),
        reason: safeErrorMessage(err),
      };
      continue;
    }

    const failure = classifyStatus({ status: response.status, headers: response.headers });
    if (failure !== null) {
      // 取消 body,避免连接悬挂。
      await response.body?.cancel().catch(() => {});
      lastFailure = {
        ok: false,
        failureKind: failure,
        reason: `${service.url} 返回 ${response.status}`,
      };
      continue;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      lastFailure = { ok: false, failureKind: classifyError(err), reason: safeErrorMessage(err) };
      continue;
    }

    const ip = service.extract(text);
    if (ip === null) {
      // 绝不把 text 放进 reason:可能是一整页 HTML 或含跳转 URL。
      lastFailure = {
        ok: false,
        failureKind: "bad_request",
        reason: `${service.url} 的响应中没有合法 IP`,
      };
      continue;
    }

    // `now` 可注入,用 `elapsedMs()` 保证写入 INTEGER 列的是非负整数。
    return { ok: true, egressIp: ip, latencyMs: elapsedMs(now, started), via: service.url };
  }

  return lastFailure;
}

async function fetchThrough(url: string, dispatcher: Dispatcher, timeoutMs: number): Promise<Response> {
  return (await fetch(url, {
    dispatcher,
    // 探测小请求可用整体超时;转发链路绝不能用总时长(不变量 #6)。
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      // 有些回显服务对默认 UA 返回 HTML 页面而非纯文本。
      accept: "text/plain, application/json",
      "user-agent": "zen-gateway/probe",
    },
    redirect: "error",
  })) as unknown as Response;
}

/**
 * 出口隔离分组:按回显实测 `egressIp` 分组,不按代理 id(不同代理可能 NAT 到同一 IP)。
 * 仅描述回显目标。未探测出 IP 的单列为「未知」,不算作已隔离。
 */
export type IsolationGroup = {
  egressIp: string;
  workerIds: string[];
  proxyIds: string[];
};

export type IsolationReport = {
  /** 每个回显 IP 一组；组内多于一个 Worker 即为该目标共用出口。 */
  groups: IsolationGroup[];
  /** 尚未探测出 IP 的 Worker。 */
  unknownWorkerIds: string[];
  /** 存在共用出口的组。 */
  sharedGroups: IsolationGroup[];
  /** 回显 IP 已知且互不共用，不表示 Zen 实际出口已验证。 */
  isolated: boolean;
};

export function buildIsolationReport(
  entries: Array<{ workerId: string; proxyId: string | null; egressIp: string | null }>,
): IsolationReport {
  const byIp = new Map<string, IsolationGroup>();
  const unknown: string[] = [];
  /** 同一个 workerId 只计一次。 */
  const seenWorkers = new Set<string>();

  for (const e of entries) {
    if (seenWorkers.has(e.workerId)) continue;
    seenWorkers.add(e.workerId);

    // 非法 IP 当作「未知」:垃圾值各自成组会误报已隔离。
    if (e.egressIp === null || !isIpAddress(e.egressIp)) {
      unknown.push(e.workerId);
      continue;
    }

    // 先规范化再分组:回显服务的 IPv6 格式各异,字符串比较会误报已隔离。
    const canonical = canonicalizeIp(e.egressIp);

    let group = byIp.get(canonical);
    if (!group) {
      group = { egressIp: canonical, workerIds: [], proxyIds: [] };
      byIp.set(canonical, group);
    }
    group.workerIds.push(e.workerId);
    if (e.proxyId !== null && !group.proxyIds.includes(e.proxyId)) {
      group.proxyIds.push(e.proxyId);
    }
  }

  const groups = [...byIp.values()];
  const sharedGroups = groups.filter((g) => g.workerIds.length > 1);

  return {
    groups,
    unknownWorkerIds: unknown,
    sharedGroups,
    // 有未知项时不敢称已隔离。
    isolated: sharedGroups.length === 0 && unknown.length === 0,
  };
}
