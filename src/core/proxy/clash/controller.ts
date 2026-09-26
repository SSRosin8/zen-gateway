import type { ClashBridge } from "../../../shared/schema.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import { isGroupType } from "../../../shared/clashNodeTypes.ts";
import { directoryBase } from "../../upstream/url.ts";
import { BlockList, isIP } from "node:net";

/**
 * Clash / Mihomo External Controller 客户端:探活、读运行配置、枚举分组与节点、切换节点、
 * 测延迟,以及供 doctor 核对选路的规则与 DNS 查询。
 * 节点名一律过 `encodeURIComponent`;错误信息不得回显 `apiSecret`,统一走 `safeErrorMessage`。
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

/**
 * 上游 host 在规则表里的首条命中。`unknown` 表示先遇到了无法在进程外判定的规则,此时不下结论。
 */
export type UpstreamRoute =
  | { kind: "matched"; index: number; type: string; payload: string; proxy: string; ip: string | null }
  | { kind: "unknown"; index: number; type: string }
  | { kind: "none" };

/** 规则类型归一化：mihomo 报 `DomainSuffix`，原版 Clash 报 `DOMAIN-SUFFIX`。 */
function normType(type: string): string {
  return type.toLowerCase().replace(/[-_]/g, "");
}

/**
 * 按内核顺序语义找首条命中。只判定与 host/IP 直接相关的类型;其余返回 `unknown` 而不是跳过,
 * 否则后面的私网规则会被误报成命中。IP 段匹配用 `net.BlockList`。
 */
export function matchUpstreamRule(rules: readonly unknown[], host: string, ips: readonly string[] | null): UpstreamRoute {
  const h = host.toLowerCase();
  for (const [i, entry] of rules.entries()) {
    if (entry === null || typeof entry !== "object") continue;
    const r = entry as { type?: unknown; payload?: unknown; proxy?: unknown };
    if (typeof r.type !== "string" || typeof r.proxy !== "string") continue;
    const type = normType(r.type);
    const payload = typeof r.payload === "string" ? r.payload.toLowerCase() : "";
    const hit = (ip: string | null) =>
      ({ kind: "matched", index: i, type: r.type as string, payload, proxy: r.proxy as string, ip }) as const;

    if (type === "domain") { if (h === payload) return hit(null); continue; }
    if (type === "domainsuffix") { if (h === payload || h.endsWith(`.${payload}`)) return hit(null); continue; }
    if (type === "domainkeyword") { if (payload !== "" && h.includes(payload)) return hit(null); continue; }
    if (type === "match") return hit(null);
    if (type === "ipcidr" || type === "ipcidr6") {
      if (ips === null) return { kind: "unknown", index: i, type: r.type };
      const [net, bitsRaw] = payload.split("/");
      const family = isIP(net ?? "");
      const bits = Number(bitsRaw);
      if (family === 0 || !Number.isInteger(bits)) return { kind: "unknown", index: i, type: r.type };
      const list = new BlockList();
      list.addSubnet(net!, bits, family === 6 ? "ipv6" : "ipv4");
      const ip = ips.find((x) => list.check(x, isIP(x) === 6 ? "ipv6" : "ipv4"));
      if (ip !== undefined) return hit(ip);
      continue;
    }
    return { kind: "unknown", index: i, type: r.type };
  }
  return { kind: "none" };
}

/**
 * Controller 交互失败的分类。`invalid_input` 表示调用方传入的名字不合法,必须单独一类:
 * `delay()` 会把 `bad_response`/`not_found` 吞成 null,配置错误会被伪装成「没有延迟数据」。
 */
export type ControllerErrorKind =
  | "unreachable"
  | "auth"
  | "not_found"
  | "bad_response"
  | "timeout"
  | "invalid_input";

export class ControllerError extends Error {
  override readonly name = "ControllerError";
  readonly kind: ControllerErrorKind;
  readonly status: number | undefined;

  constructor(
    message: string,
    kind: ControllerErrorKind,
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

/**
 * 编码单个路径段,并拒绝纯点名。WHATWG URL 把 `.`、`..`、`%2e%2e` 都当作点段归一化,
 * 编码无法保护:`select("..", n)` 会把 PUT 打到 Controller 根路径。真实分组不会叫这种名字。
 */
function encodeSegment(value: string, what: "分组" | "节点"): string {
  // 含 %2e 这类已编码形态。
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  if (/^\.+$/.test(decoded) || /^\.+$/.test(value)) {
    throw new ControllerError(
      `${what}名不能是「${value}」—— 纯点名会被 URL 路径归一化吃掉,无法安全寻址`,
      "invalid_input",
    );
  }
  if (value === "") {
    throw new ControllerError(`${what}名不能为空`, "invalid_input");
  }
  return encodeURIComponent(value);
}

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
    // 归一化后用相对路径解析：字符串拼接在 `apiBase` 带 query 时会拼出到不了的地址。
    this.#base = directoryBase(bridge.apiBase).href;

    this.#secret = bridge.apiSecret;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  #headers(): Record<string, string> {
    return this.#secret === "" ? {} : { authorization: `Bearer ${this.#secret}` };
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    // path 是相对路径(如 `proxies/GLOBAL`)。
    const url = new URL(path, this.#base).href;
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
      throw new ControllerError(
        `无法连接 Controller ${this.#base}:${safeErrorMessage(err)}`,
        "unreachable",
      );
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      // 绝不回显 secret。
      throw new ControllerError(
        `Controller 拒绝鉴权(${res.status});检查 apiSecret 配置`,
        "auth",
        res.status,
      );
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ControllerError("Controller 返回 404(分组或节点不存在)", "not_found", 404);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
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

  /** 探活,返回内核版本。 */
  async version(): Promise<{ version: string; isMeta: boolean }> {
    const body = await this.#json("version");
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

  /**
   * 读运行配置的选路模式与混合端口;缺失时各自为 null,由调用方定默认值。
   * 混合端口缺失不能用 `socks-port`/`port` 代替:桥接 dispatcher 使用 HTTP CONNECT。
   */
  async runtimeConfig(): Promise<{ mode: string | null; mixedPort: number | null }> {
    const body = (await this.#json("configs")) as { mode?: unknown; "mixed-port"?: unknown } | null;
    const port = body?.["mixed-port"];
    return {
      mode: typeof body?.mode === "string" ? body.mode.toLowerCase() : null,
      mixedPort: typeof port === "number" && port > 0 ? port : null,
    };
  }

  /**
   * 规则实际把流量导向哪些分组。`GLOBAL` 陷阱不能靠名字判断:`mode: rule` 下不参与选路的分组
   * 切换也返回 204、探测也能拿到 IP;真正判据是 `/rules` 的导向。兜底规则 `MATCH` 单独给出,
   * 它最可能是转发到 `opencode.ai` 时命中的那条。
   */
  async routedGroups(): Promise<{ targets: ReadonlyMap<string, number>; fallback: string | null }> {
    const rules = await this.#rules();
    const targets = new Map<string, number>();
    let fallback: string | null = null;
    for (const entry of rules) {
      if (entry === null || typeof entry !== "object") continue;
      const rule = entry as { type?: unknown; proxy?: unknown };
      const proxy = typeof rule.proxy === "string" ? rule.proxy : "";
      if (proxy === "") continue;
      targets.set(proxy, (targets.get(proxy) ?? 0) + 1);
      // mihomo 报 "Match",原版 Clash 报 "MATCH"。
      if (typeof rule.type === "string" && rule.type.toLowerCase() === "match") {
        fallback = proxy;
      }
    }
    return { targets, fallback };
  }

  /**
   * 上游 host 在规则表里会命中哪一条。分组参与选路不代表上游请求走到它:私网
   * `IPCIDR → DIRECT` 可能先命中(企业 DNS 把公网域名解析到内网时),Worker 会静默共用出口。
   * 解析用内核自己的 `/dns/query`;读不到 DNS 时 IP 规则视为无法判定。
   */
  async upstreamRoute(host: string): Promise<UpstreamRoute> {
    const rules = await this.#rules();
    const ips = await this.#resolve(host);
    return matchUpstreamRule(rules, host, ips);
  }

  async #rules(): Promise<unknown[]> {
    const body = await this.#json("rules");
    const rules = (body as { rules?: unknown } | null)?.rules;
    if (!Array.isArray(rules)) {
      throw new ControllerError("/rules 的 rules 不是数组", "bad_response");
    }
    return rules;
  }

  async #resolve(host: string): Promise<string[] | null> {
    if (isIP(host) !== 0) return [host];
    const out: string[] = [];
    try {
      for (const type of ["A", "AAAA"]) {
        const body = (await this.#json(`dns/query?name=${encodeURIComponent(host)}&type=${type}`)) as {
          Answer?: Array<{ data?: unknown }>;
        } | null;
        for (const a of body?.Answer ?? []) {
          if (typeof a.data === "string" && isIP(a.data) !== 0) out.push(a.data);
        }
      }
    } catch {
      return null;
    }
    return out;
  }

  async #proxies(): Promise<Record<string, unknown>> {
    const body = await this.#json("proxies");
    const proxies = (body as { proxies?: unknown } | null)?.proxies;
    if (proxies === null || typeof proxies !== "object") {
      throw new ControllerError("/proxies 返回的不是对象", "bad_response");
    }
    return proxies as Record<string, unknown>;
  }

  /** 枚举全部 selector 分组。 */
  async selectors(): Promise<SelectorGroup[]> {
    const proxies = await this.#proxies();
    const out: SelectorGroup[] = [];
    for (const [name, value] of Object.entries(proxies)) {
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
    const proxies = await this.#proxies();
    const out: ProxyNode[] = [];
    for (const [name, value] of Object.entries(proxies)) {
      if (value === null || typeof value !== "object") continue;
      const node = value as { type?: unknown; history?: unknown };
      const type = typeof node.type === "string" ? node.type : "";
      // 分组与内置策略不是可出口的节点。
      if (isGroupType(type)) continue;

      const history = Array.isArray(node.history) ? node.history : [];
      const last = history.at(-1) as { delay?: unknown } | undefined;
      const delay = typeof last?.delay === "number" && last.delay > 0 ? last.delay : null;

      out.push({ name, type, latencyMs: delay });
    }
    return out;
  }

  /** 切换 selector 的选中节点;调用方必须持有该内核的 SelectorLock。 */
  async select(group: string, node: string): Promise<void> {
    await this.#request(`proxies/${encodeSegment(group, "分组")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: node }),
    });
  }

  /** 读取单个分组的当前选中节点。 */
  async currentNode(group: string): Promise<string> {
    const body = await this.#json(`proxies/${encodeSegment(group, "分组")}`);
    const now = (body as { now?: unknown })?.now;
    if (typeof now !== "string") {
      throw new ControllerError(`分组 ${group} 没有 now 字段(可能不是 Selector)`, "bad_response");
    }
    return now;
  }

  /** 测某个节点的控制面延迟:证明节点可用,不证明流量从该节点出去(出口隔离见 probe.ts)。 */
  async delay(node: string, testUrl: string): Promise<number | null> {
    const query = new URLSearchParams({ timeout: String(DELAY_TIMEOUT_MS), url: testUrl });
    try {
      const body = await this.#json(
        `proxies/${encodeSegment(node, "节点")}/delay?${query}`,
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
