import { fetch, type Dispatcher } from "undici";
import type { FailureKind } from "../failures.ts";
import { classifyError, classifyStatus } from "../failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import type { SelectorLock } from "./selectorLock.ts";
import type { ClashController } from "./clash/controller.ts";

/**
 * 出口探测 —— 数据面。
 *
 * 唯一目的:**实测这条链路的公网出口 IP**。
 *
 * 为什么不能用 Clash Controller 的 `/delay` 代替:那是控制面延迟,由 Clash
 * 自己去连测试 URL。它证明节点可用,但**不证明我们的流量真的从那个节点出去**。
 * 出口隔离的整个价值在于「两个 Worker 的流量从不同公网 IP 出去」,
 * 而这件事只能由我们自己的请求实测回显的 IP 来证明。
 *
 * 出口隔离的判定必须按实测 IP 分组,不能按代理 id:两个不同代理可能
 * NAT 到同一个公网 IP,那种情况下「已隔离」是假的。
 */

/**
 * IP 回显服务。
 *
 * 多个候选并依次回退:单一服务挂掉或被墙会让整个探测功能失效,
 * 而这个功能是出口隔离的唯一验证手段。
 *
 * 只取 IP,不取地理位置等附加信息 —— 少一个字段就少一处解析分歧。
 */
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

/**
 * IP 字面量校验。
 *
 * 必须校验:回显服务被劫持或返回一页 HTML 时,未校验的实现会把整段文本
 * 当成「出口 IP」存进配置,于是隔离判定按一串垃圾分组,看起来全都「不同」。
 */
export function isIpAddress(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;

  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => {
      const n = Number(part);
      // 拒绝前导零:010 在不同解析器里含义不同。
      return n <= 255 && String(n) === part;
    });
  }

  // IPv6:只做保守的字符与结构检查,不求完整实现。
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(":")) {
    return value.split("::").length <= 2 && value.split(":").length <= 8;
  }

  return false;
}

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
 *
 * 桥接模式下,「切换 selector + 发出请求直到响应头到达」在锁内完成;
 * 响应体的读取在锁外 —— 见 SelectorLock 的说明:锁若跨到流结束,
 * 整个网关会被单条长连接串行化。探测的响应体只有几十字节,
 * 这里的差别不大,但保持同一套边界,免得 Phase 3 照抄出错。
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
      // 读完并丢弃,避免连接悬挂。
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
      /*
       * 回显服务被劫持、返回 HTML、或改了响应格式。
       * 绝不把 text 放进 reason:那可能是一整页 HTML,也可能含跳转 URL。
       */
      lastFailure = {
        ok: false,
        failureKind: "bad_request",
        reason: `${service.url} 的响应中没有合法 IP`,
      };
      continue;
    }

    return { ok: true, egressIp: ip, latencyMs: now() - started, via: service.url };
  }

  return lastFailure;
}

async function fetchThrough(url: string, dispatcher: Dispatcher, timeoutMs: number): Promise<Response> {
  return (await fetch(url, {
    dispatcher,
    // dispatcher 已带 headersTimeout/bodyTimeout;这里的 signal 是整体上限,
    // 对探测这种小请求是合适的(不同于转发链路 —— 那里绝不能用总时长)。
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
 * 出口隔离分组。
 *
 * **按实测 `egressIp` 分组,不按代理 id。**
 * 旧实现按 proxyId 判断是否共用出口,从不比较实测 IP —— 两个不同代理
 * NAT 到同一公网 IP 时会被报成「已隔离」,而隔离恰恰是这个项目存在的理由,
 * 这个判断错了整个功能就是假的。
 *
 * 未探测出 IP 的记录单列为「未知」,**不算作已隔离** ——
 * 「还不知道」和「确认不同」是两件事,混在一起会给出虚假的安全感。
 */
export type IsolationGroup = {
  egressIp: string;
  workerIds: string[];
  proxyIds: string[];
};

export type IsolationReport = {
  /** 每个 IP 一组;组内多于一个 Worker 即为共用出口。 */
  groups: IsolationGroup[];
  /** 尚未探测出 IP 的 Worker。 */
  unknownWorkerIds: string[];
  /** 存在共用出口的组。 */
  sharedGroups: IsolationGroup[];
  isolated: boolean;
};

export function buildIsolationReport(
  entries: Array<{ workerId: string; proxyId: string | null; egressIp: string | null }>,
): IsolationReport {
  const byIp = new Map<string, IsolationGroup>();
  const unknown: string[] = [];

  for (const e of entries) {
    if (e.egressIp === null || e.egressIp === "") {
      unknown.push(e.workerId);
      continue;
    }
    let group = byIp.get(e.egressIp);
    if (!group) {
      group = { egressIp: e.egressIp, workerIds: [], proxyIds: [] };
      byIp.set(e.egressIp, group);
    }
    group.workerIds.push(e.workerId);
    // 同一 IP 下可能有多个不同代理 —— 这正是「看起来隔离其实没隔离」的形态。
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
