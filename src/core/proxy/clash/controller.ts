import type { ClashBridge } from "../../../shared/schema.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";

/**
 * Clash / Mihomo External Controller 客户端。
 *
 * 只覆盖本项目需要的四件事:探活、枚举 selector 分组、切换选中节点、测延迟。
 *
 * ## 节点名必须 URL 编码
 *
 * 实测本机 mihomo 1.10.0 的节点名形如
 * `🇺🇲 示例节点2 IPLC  VIP2 网址:example.invalid` —— 含空格、冒号、emoji
 * (国旗是多码点序列)、连续空格。直接拼进 path 会产生非法 URL 或指向错误的资源,
 * 所以每一处都过 `encodeURIComponent`。这不是防御性编程,是这批真实数据的硬要求。
 *
 * ## secret 是凭证
 *
 * 任何错误信息都不得回显 `apiSecret`。这里统一走 `safeErrorMessage`,
 * 并且绝不把 apiBase 以外的 URL 片段放进错误。
 */

export type SelectorGroup = {
  name: string;
  /** 当前选中的节点名。 */
  now: string;
  /** 可选节点名列表。 */
  options: string[];
};

export type ProxyNode = {
  name: string;
  type: string;
  /** 最近一次延迟(ms);无历史记录时为 null。 */
  latencyMs: number | null;
};

export class ControllerError extends Error {
  override readonly name = "ControllerError";
  readonly kind: "unreachable" | "auth" | "not_found" | "bad_response" | "timeout";
  readonly status: number | undefined;

  constructor(
    message: string,
    kind: "unreachable" | "auth" | "not_found" | "bad_response" | "timeout",
    status?: number,
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** 控制面请求的默认超时:本机通信,不需要很久。 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** 延迟测试的超时上限,避免一个坏节点拖住整批探测。 */
const DELAY_TIMEOUT_MS = 5_000;

export type ControllerOptions = {
  timeoutMs?: number;
  /** 注入 fetch 便于测试;默认用全局 fetch(控制面是本机 HTTP,无需代理)。 */
  fetchImpl?: typeof fetch;
};

export class ClashController {
  readonly bridgeId: string;
  #base: string;
  #secret: string;
  #timeoutMs: number;
  #fetch: typeof fetch;

  constructor(bridge: Pick<ClashBridge, "id" | "apiBase" | "apiSecret">, opts: ControllerOptions = {}) {
    this.bridgeId = bridge.id;
    // 去掉末尾斜杠,避免拼出 //proxies。
    this.#base = bridge.apiBase.replace(/\/+$/, "");
    this.#secret = bridge.apiSecret;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  #headers(): Record<string, string> {
    return this.#secret === "" ? {} : { authorization: `Bearer ${this.#secret}` };
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    const url = `${this.#base}${path}`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        ...init,
        headers: { ...this.#headers(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ControllerError(`Controller ${this.#base} 响应超时`, "timeout");
      }
      // safeErrorMessage 兜住任何可能含凭证的底层消息。
      throw new ControllerError(
        `无法连接 Controller ${this.#base}:${safeErrorMessage(err)}`,
        "unreachable",
      );
    }

    if (res.status === 401 || res.status === 403) {
      // 绝不回显 secret —— 只说明是鉴权问题。
      throw new ControllerError(
        `Controller 拒绝鉴权(${res.status});检查 apiSecret 配置`,
        "auth",
        res.status,
      );
    }
    if (res.status === 404) {
      throw new ControllerError("Controller 返回 404(分组或节点不存在)", "not_found", 404);
    }
    if (!res.ok) {
      throw new ControllerError(`Controller 返回 ${res.status}`, "bad_response", res.status);
    }
    return res;
  }

  async #json(path: string, init?: RequestInit, timeoutMs?: number): Promise<unknown> {
    const res = await this.#request(path, init, timeoutMs);
    try {
      return await res.json();
    } catch {
      throw new ControllerError("Controller 返回的不是合法 JSON", "bad_response", res.status);
    }
  }

  /** 探活。返回内核版本字符串。 */
  async version(): Promise<{ version: string; isMeta: boolean }> {
    const body = await this.#json("/version");
    if (body === null || typeof body !== "object") {
      throw new ControllerError("/version 返回的不是对象", "bad_response");
    }
    const raw = body as { version?: unknown; meta?: unknown };
    return {
      version: typeof raw.version === "string" ? raw.version : "unknown",
      // mihomo 会带 meta:true;原版 Clash 没有这个字段。
      isMeta: raw.meta === true,
    };
  }

  /** 枚举全部 selector 分组。 */
  async selectors(): Promise<SelectorGroup[]> {
    const body = await this.#json("/proxies");
    const proxies = (body as { proxies?: unknown })?.proxies;
    if (proxies === null || typeof proxies !== "object") {
      throw new ControllerError("/proxies 返回的不是对象", "bad_response");
    }

    const out: SelectorGroup[] = [];
    for (const [name, value] of Object.entries(proxies as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const node = value as { type?: unknown; now?: unknown; all?: unknown };
      if (node.type !== "Selector") continue;
      out.push({
        name,
        now: typeof node.now === "string" ? node.now : "",
        options: Array.isArray(node.all) ? node.all.filter((x): x is string => typeof x === "string") : [],
      });
    }
    return out;
  }

  /** 列出全部可选节点(含最近延迟),用于导入代理池。 */
  async nodes(): Promise<ProxyNode[]> {
    const body = await this.#json("/proxies");
    const proxies = (body as { proxies?: unknown })?.proxies;
    if (proxies === null || typeof proxies !== "object") {
      throw new ControllerError("/proxies 返回的不是对象", "bad_response");
    }

    const out: ProxyNode[] = [];
    for (const [name, value] of Object.entries(proxies as Record<string, unknown>)) {
      if (value === null || typeof value !== "object") continue;
      const node = value as { type?: unknown; history?: unknown };
      const type = typeof node.type === "string" ? node.type : "";
      // 分组与内置策略不是可出口的节点。
      if (GROUP_TYPES.has(type)) continue;

      const history = Array.isArray(node.history) ? node.history : [];
      const last = history.at(-1) as { delay?: unknown } | undefined;
      const delay = typeof last?.delay === "number" && last.delay > 0 ? last.delay : null;

      out.push({ name, type, latencyMs: delay });
    }
    return out;
  }

  /**
   * 切换 selector 的选中节点。
   *
   * 调用方**必须**持有该内核的 SelectorLock:selector 的 `now` 是全局状态,
   * 并发切换会让两个请求互相换掉对方的出口节点。
   */
  async select(group: string, node: string): Promise<void> {
    // 节点名含空格/冒号/emoji,必须编码。
    await this.#request(`/proxies/${encodeURIComponent(group)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: node }),
    });
  }

  /** 读取单个分组的当前选中节点。 */
  async currentNode(group: string): Promise<string> {
    const body = await this.#json(`/proxies/${encodeURIComponent(group)}`);
    const now = (body as { now?: unknown })?.now;
    if (typeof now !== "string") {
      throw new ControllerError(`分组 ${group} 没有 now 字段(可能不是 Selector)`, "bad_response");
    }
    return now;
  }

  /**
   * 测某个节点的延迟。
   *
   * 这是**控制面**的延迟,由 Clash 自己去连测试 URL —— 它证明节点可用,
   * 但不证明我们的流量真的从那个节点出去。出口隔离必须靠数据面实测公网 IP
   * (见 probe.ts),不能用这个数字代替。
   */
  async delay(node: string, testUrl: string): Promise<number | null> {
    const query = new URLSearchParams({ timeout: String(DELAY_TIMEOUT_MS), url: testUrl });
    try {
      const body = await this.#json(
        `/proxies/${encodeURIComponent(node)}/delay?${query}`,
        undefined,
        DELAY_TIMEOUT_MS + 1_000,
      );
      const delay = (body as { delay?: unknown })?.delay;
      return typeof delay === "number" && delay > 0 ? delay : null;
    } catch (err) {
      // 节点不可用时 Clash 返回非 2xx;这不是 Controller 故障,如实返回 null。
      if (err instanceof ControllerError && (err.kind === "bad_response" || err.kind === "not_found")) {
        return null;
      }
      throw err;
    }
  }
}

/** 分组与内置策略的 type —— 这些不是可出口的节点。 */
const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "Direct",
  "Reject",
  "RejectDrop",
  "Pass",
  "Compatible",
  "Dns",
]);
