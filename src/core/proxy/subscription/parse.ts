/**
 * 订阅体解析 —— **纯函数**，不发请求。
 *
 * 拉取在 `core/proxy/subscription/fetch.ts`；这里只回答「这段文本里有哪些节点」。
 * 分开的理由与 `routing/` 那几块同源：格式判定能被穷举测试，而网络那层只需
 * 验证「接得对」。订阅格式是本项目**最不可控**的输入（由第三方服务商决定，
 * 随时会变），所以它必须是可以拿一段文本反复喂的纯函数。
 *
 * ## 支持的四类形态
 *
 * | 形态 | 判据 |
 * |---|---|
 * | Clash YAML/JSON | 顶层有 `proxies:` 数组 |
 * | SIP008 | 顶层有 `servers:` 数组（JSON） |
 * | 分享链列表 | 每行一个 `scheme://…` |
 * | 多层 Base64 | 整体是 base64，解开后是上面三者之一 |
 *
 * ## 为什么是「多层」Base64
 *
 * 实测存在**双层**编码的订阅（服务商把已经是 base64 的链接列表又编了一遍，
 * 通常是被中间层重新打包过）。所以要循环解码，但**必须有深度上限**：
 * 一段恰好长得像 base64 的文本可以无限自我解码下去，那是一个
 * 停不下来的循环。上限 3 层。
 *
 * ## 安全：这段文本完全不可信
 *
 * 订阅 URL 自带 token，而响应体来自第三方。三条硬规则：
 *
 * 1. **解析失败绝不把原文放进错误消息**。订阅体里每一行都可能是凭证
 *    （ss:// 链接的 userinfo 段就是密码）。只给分类后的 `kind`。
 * 2. **条目数与体积都要有上限**，否则一个恶意/故障的订阅能把内存吃光。
 * 3. **绝不信任 `type` 字段决定能否出口** —— 那个判定归
 *    `isDirectCapable`（单一真相），这里只负责把原始协议名带出来。
 */

import { parse as parseYaml } from "yaml";
import { isGroupType } from "../../../shared/clashNodeTypes.ts";
import { isDirectCapable } from "../dispatcher.ts";

/**
 * 解析出来的一个节点 —— 刻意**不是** `Proxy`。
 *
 * `Proxy` 需要 `id`（要稳定去重）与 `subscriptionId`（调用方才知道），
 * 而那两样都不是"这段文本说了什么"的一部分。让纯函数造 id 会让它
 * 要么依赖随机数（不可测）要么依赖调用方传进来的种子（多一个参数）。
 * 所以这里只输出**事实**，组装成 `Proxy` 是 `importProxies` 的事。
 */
export type ParsedNode = {
  readonly name: string;
  /** 原始协议名，小写。可能是 `vless`/`hysteria2` 这类只能桥接的类型。 */
  readonly type: string;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
};

export type SubscriptionFormat = "clash" | "sip008" | "uri-list" | "empty";

/**
 * Clash 配置里顺带给出的本机信息。
 *
 * 订阅体里的 `mixed-port` / `external-controller` 只是**提示**，
 * 不是真相：真正在跑的内核可能用了别的端口（用户改过、或多内核并存）。
 * 真相只能从 Controller 的 `/configs` 读（那是实测钉下的结论）。
 * 所以这些字段只用于"猜一个默认值填进表单"，绝不能直接拿来配桥接。
 */
export type ClashHints = {
  readonly mixedPort?: number;
  readonly socksPort?: number;
  readonly httpPort?: number;
  readonly externalController?: string;
  readonly selectorGroups?: readonly string[];
};

export type ParseResult = {
  readonly nodes: readonly ParsedNode[];
  readonly format: SubscriptionFormat;
  /** 认出了形态但某些条目不合法（缺 host/端口越界）时的丢弃数。 */
  readonly skipped: number;
  readonly hints?: ClashHints;
};

/** 单个订阅最多接受的节点数。实测本机一个订阅 79 个，给两个数量级余量。 */
export const MAX_NODES = 2000;

/** Base64 最多解几层 —— 见文件头。 */
const MAX_BASE64_DEPTH = 3;

/** 只能经 Clash 桥接的隧道协议。这份清单只用于**认识**分享链的 scheme。 */
const TUNNEL_SCHEMES = new Set([
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "hy2",
  "tuic",
  "wireguard",
  "anytls",
  "snell",
]);

/* ------------------------------------------------------------------ *
 * 基础解码
 * ------------------------------------------------------------------ */

/**
 * 宽松 Base64 解码（兼容 URL-safe 与缺省填充）。
 *
 * 返回 `null` 表示"这不是 base64"，而不是抛错 —— 调用方要靠它做形态判定。
 *
 * **解出来含控制字符就算失败**：一段二进制被解成"字符串"不代表解对了。
 * 少了这条检查，任意二进制都会被当成解码成功，然后在下游变成一堆垃圾节点名。
 */
function decodeBase64(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (cleaned === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  // 长度不足 4 的"base64"几乎必然是误判（一个 3 字母的节点名会命中上面的正则）。
  if (cleaned.length < 8) return null;
  try {
    const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    if (decoded === "") return null;
    // 允许 \t \n \r，其余控制字符说明这不是文本。
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** 分享链的 `#备注` 段是 percent-encoded 的，`+` 也要当空格。 */
function decodeLabel(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // 一个坏的百分号转义不该让整个节点被丢掉 —— 名字是展示用的。
    return value;
  }
}

/** 看起来已经是结构化文本（YAML/JSON）或链接列表了吗？ */
function looksDecoded(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if (/^(?:proxies|servers|mixed-port|port|socks-port)\s*:/m.test(t)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\//im.test(t);
}

/**
 * 逐层解开 Base64 外壳。
 *
 * 循环终止有**三个**条件，缺一个就可能停不下来或过度解码：
 * 已经看起来是结构化文本、解不出来、解出来和原文一样（自反的 base64）。
 */
function peelBase64(body: string): string {
  let text = body.trim().replace(/^﻿/, "");
  for (let depth = 0; depth < MAX_BASE64_DEPTH; depth += 1) {
    if (looksDecoded(text)) break;
    const decoded = decodeBase64(text);
    if (decoded === null || decoded === text) break;
    text = decoded.trim().replace(/^﻿/, "");
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 端点与字段提取
 * ------------------------------------------------------------------ */

function validPort(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const port = Math.floor(n);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 解析 `host:port`，含 IPv6 的 `[::1]:443` 形态。 */
function parseEndpoint(value: string): { host: string; port: number } | null {
  const raw = value.trim();
  if (raw.startsWith("[")) {
    const m = /^\[([^\]]+)]:(\d+)$/.exec(raw);
    if (m === null) return null;
    const port = validPort(m[2]);
    return port === null || m[1] === undefined || m[1] === "" ? null : { host: m[1], port };
  }
  // 用 lastIndexOf：裸 IPv6 没有方括号时前面的冒号都属于地址。
  const colon = raw.lastIndexOf(":");
  if (colon < 1) return null;
  const host = raw.slice(0, colon);
  const port = validPort(raw.slice(colon + 1));
  return host === "" || port === null ? null : { host, port };
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

function node(
  type: string,
  host: string,
  port: number,
  name: string,
  username?: string,
  password?: string,
): ParsedNode {
  const normalized = type.toLowerCase() === "hy2" ? "hysteria2" : type.toLowerCase();
  return {
    name: name === "" ? `${normalized}://${host}:${port}` : name,
    type: normalized,
    host,
    port,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

/* ------------------------------------------------------------------ *
 * Clash YAML / SIP008
 * ------------------------------------------------------------------ */

function clashItem(item: Record<string, unknown>): ParsedNode | null {
  const host = firstString(item.server, item.host);
  const port = validPort(item.port ?? item.server_port);
  if (host === undefined || port === null) return null;

  const type = firstString(item.type) ?? "http";
  // 分组混进 `proxies:` 是实测存在的形态 —— 见 `clashNodeTypes.ts`。
  if (isGroupType(type)) return null;

  return node(
    type,
    host,
    port,
    firstString(item.name) ?? "",
    firstString(item.username, item.user, item.uuid),
    firstString(item.password, item.pass, item.psk),
  );
}

function sip008Item(item: Record<string, unknown>): ParsedNode | null {
  const host = firstString(item.server);
  const port = validPort(item.server_port);
  if (host === undefined || port === null) return null;
  return node(
    "ss",
    host,
    port,
    firstString(item.remarks) ?? "",
    // SIP008 的 `method` 是加密方式，放在 username 位只是为了不丢信息
    // —— 桥接路径不读它，直连路径也用不到（ss 不能直连）。
    firstString(item.method),
    firstString(item.password),
  );
}

function extractHints(doc: Record<string, unknown>): ClashHints | undefined {
  const hints: {
    mixedPort?: number;
    socksPort?: number;
    httpPort?: number;
    externalController?: string;
    selectorGroups?: string[];
  } = {};

  const mixed = validPort(doc["mixed-port"]);
  if (mixed !== null) hints.mixedPort = mixed;
  const socks = validPort(doc["socks-port"]);
  if (socks !== null) hints.socksPort = socks;
  const http = validPort(doc.port);
  if (http !== null) hints.httpPort = http;

  const ctrl = firstString(doc["external-controller"]);
  if (ctrl !== undefined) {
    const trimmed = ctrl.trim();
    // `external-controller` 常写成 `127.0.0.1:9090`（没有 scheme）。
    hints.externalController = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  const groups = doc["proxy-groups"];
  if (Array.isArray(groups)) {
    const names = groups.flatMap((g) => {
      if (g === null || typeof g !== "object") return [];
      const group = g as Record<string, unknown>;
      const type = firstString(group.type) ?? "";
      const name = firstString(group.name);
      // 只收 `select` —— 只有它能被 Controller 切换（url-test 是自动的）。
      return type.toLowerCase() === "select" && name !== undefined ? [name] : [];
    });
    if (names.length > 0) hints.selectorGroups = names;
  }

  return Object.keys(hints).length > 0 ? hints : undefined;
}

/**
 * 解析结构化文本（YAML 是 JSON 的超集，所以一个解析器覆盖两者）。
 *
 * 返回 `null` 表示"不是结构化形态"，交给分享链列表那条路。
 */
function parseStructured(
  text: string,
): { nodes: ParsedNode[]; skipped: number; format: "clash" | "sip008"; hints?: ClashHints } | null {
  let doc: unknown;
  try {
    doc = parseYaml(text, {
      // 一个 5MB 的订阅体不该因为 YAML 的锚点展开变成 5GB（billion laughs）。
      maxAliasCount: 100,
    });
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const record = doc as Record<string, unknown>;

  if (Array.isArray(record.proxies)) {
    const items = record.proxies.slice(0, MAX_NODES);
    const nodes: ParsedNode[] = [];
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const parsed = clashItem(item as Record<string, unknown>);
      if (parsed !== null) nodes.push(parsed);
    }
    const hints = extractHints(record);
    return {
      nodes,
      skipped: items.length - nodes.length,
      format: "clash",
      ...(hints === undefined ? {} : { hints }),
    };
  }

  if (Array.isArray(record.servers)) {
    const items = record.servers.slice(0, MAX_NODES);
    const nodes: ParsedNode[] = [];
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const parsed = sip008Item(item as Record<string, unknown>);
      if (parsed !== null) nodes.push(parsed);
    }
    return { nodes, skipped: items.length - nodes.length, format: "sip008" };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 分享链
 * ------------------------------------------------------------------ */

function parseVmess(payload: string): ParsedNode | null {
  const decoded = decodeBase64(payload);
  if (decoded === null) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object") return null;
  const v = doc as Record<string, unknown>;
  const host = firstString(v.add);
  const port = validPort(v.port);
  if (host === undefined || port === null) return null;
  return node("vmess", host, port, firstString(v.ps) ?? "", firstString(v.id));
}

/**
 * `ss://` 有两种写法：整体 base64、或 `base64(method:pass)@host:port`。
 * 两种都要认 —— 不同客户端生成的不一样。
 */
function parseShadowsocks(payload: string): ParsedNode | null {
  const hash = payload.indexOf("#");
  const label = hash >= 0 ? decodeLabel(payload.slice(hash + 1)) : "";
  let main = hash >= 0 ? payload.slice(0, hash) : payload;
  main = main.split("?")[0] ?? main;

  // 整体编码的形态：解开之后才有 `@`。
  if (!main.includes("@")) {
    const decoded = decodeBase64(main);
    if (decoded !== null) main = decoded;
  }

  const at = main.lastIndexOf("@");
  if (at < 1) return null;

  let credentials = main.slice(0, at);
  const decodedCreds = decodeBase64(credentials);
  if (decodedCreds !== null && decodedCreds.includes(":")) credentials = decodedCreds;

  const endpoint = parseEndpoint(main.slice(at + 1));
  if (endpoint === null) return null;

  const split = credentials.indexOf(":");
  const method = split >= 0 ? decodeLabel(credentials.slice(0, split)) : undefined;
  const password = decodeLabel(split >= 0 ? credentials.slice(split + 1) : credentials);
  return node("ss", endpoint.host, endpoint.port, label, method, password);
}

/** `ssr://` 是 `host:port:protocol:method:obfs:base64(pass)/?params` 整体再 base64。 */
function parseSsr(payload: string): ParsedNode | null {
  const decoded = decodeBase64(payload);
  if (decoded === null) return null;
  const [main = "", query = ""] = decoded.split("/?", 2);
  const parts = main.split(":");
  if (parts.length < 6) return null;
  const host = parts[0] ?? "";
  const port = validPort(parts[1]);
  if (host === "" || port === null) return null;

  const params = new URLSearchParams(query);
  const remarks = params.get("remarks");
  const label = remarks === null ? "" : (decodeBase64(remarks) ?? decodeLabel(remarks));
  const passwordRaw = parts.slice(5).join(":");
  return node("ssr", host, port, label, parts[3], decodeBase64(passwordRaw) ?? undefined);
}

/** `http(s)://` 与 `socks…://` —— 交给 WHATWG URL，不手写解析。 */
function parseStandard(raw: string, scheme: string): ParsedNode | null {
  try {
    // `socks5h` 不是合法 scheme 里 URL 能处理的形态之一，先归一。
    const normalized = scheme === "socks5h" ? `socks5://${raw.slice(raw.indexOf("://") + 3)}` : raw;
    const url = new URL(normalized);
    if (url.hostname === "") return null;
    const port =
      url.port === "" ? (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80) : validPort(url.port);
    if (port === null) return null;
    const type = scheme === "socks" || scheme === "socks5h" ? "socks5" : scheme === "socks4a" ? "socks4" : scheme;
    return node(
      type,
      // `URL.hostname` 对 IPv6 会带方括号，而配置里存的是裸地址。
      url.hostname.replace(/^\[|]$/g, ""),
      port,
      decodeLabel(url.hash.slice(1)),
      url.username === "" ? undefined : decodeLabel(url.username),
      url.password === "" ? undefined : decodeLabel(url.password),
    );
  } catch {
    return null;
  }
}

/** 其余隧道协议：`scheme://userinfo@host:port?params#label`。 */
function parseTunnel(payload: string, scheme: string): ParsedNode | null {
  const hash = payload.lastIndexOf("#");
  const label = hash >= 0 ? decodeLabel(payload.slice(hash + 1)) : "";
  const body = hash >= 0 ? payload.slice(0, hash) : payload;
  const main = body.split("?")[0] ?? body;
  const at = main.lastIndexOf("@");
  const endpoint = parseEndpoint(at >= 0 ? main.slice(at + 1) : main);
  if (endpoint === null) return null;

  const userinfo = at >= 0 ? main.slice(0, at) : "";
  const split = userinfo.indexOf(":");
  const username =
    userinfo === "" ? undefined : decodeLabel(split >= 0 ? userinfo.slice(0, split) : userinfo);
  const password = split >= 0 ? decodeLabel(userinfo.slice(split + 1)) : undefined;
  return node(scheme, endpoint.host, endpoint.port, label, username, password);
}

/**
 * 解析一条分享链。
 *
 * 不认识的 scheme 返回 `null`（而不是硬塞成 http）—— 猜错协议会造出一个
 * 连得上但走错路的代理，而那种失败比"没导入"难查得多。
 */
export function parseShareLink(line: string): ParsedNode | null {
  const raw = line.trim();
  if (raw === "" || raw.startsWith("#") || raw.startsWith("//")) return null;
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(raw);
  if (m === null) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  const payload = m[2] ?? "";

  if (scheme === "vmess") return parseVmess(payload);
  if (scheme === "ss") return parseShadowsocks(payload);
  if (scheme === "ssr") return parseSsr(payload);
  if (/^(?:https?|socks|socks4a?|socks5h?)$/.test(scheme)) return parseStandard(raw, scheme);
  if (TUNNEL_SCHEMES.has(scheme)) return parseTunnel(payload, scheme);
  return null;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 解析一个订阅体。
 *
 * **绝不抛错**：订阅体是第三方输入，任何形态都只该得到一个"解出 0 个节点"
 * 的结果而不是一个异常 —— 上层要区分的是「拉取失败」与「拉到了但解不出」，
 * 而抛错会把后者混进前者。
 */
export function parseSubscription(body: string): ParseResult {
  const text = peelBase64(body);
  if (text === "") return { nodes: [], format: "empty", skipped: 0 };

  const structured = parseStructured(text);
  if (structured !== null) {
    return {
      nodes: structured.nodes,
      format: structured.nodes.length === 0 ? "empty" : structured.format,
      skipped: structured.skipped,
      ...(structured.hints === undefined ? {} : { hints: structured.hints }),
    };
  }

  /*
   * 按**行**切，不按空白切。
   *
   * 节点名（`#` 后面那段）里可能有未编码的空格 —— 实测订阅确实这么给。
   * 按 `\s+` 切会把一条链接劈成两半，两半都解析失败，于是那个节点静默消失。
   */
  const lines = text.split(/\r?\n/);
  const nodes: ParsedNode[] = [];
  let considered = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (nodes.length >= MAX_NODES) break;
    considered += 1;
    const parsed = parseShareLink(line);
    if (parsed !== null) nodes.push(parsed);
  }

  return {
    nodes,
    format: nodes.length === 0 ? "empty" : "uri-list",
    skipped: considered - nodes.length,
  };
}

/**
 * 这个节点能不能用（直连或桥接）。
 *
 * `direct` 走 `isDirectCapable`（**唯一真相**，dispatcher 也用它）。
 * `bridgeable` 对所有节点都是 true —— Clash 内核支持的协议远多于本项目
 * 能直连的四种，而"这个协议内核认不认"只有内核知道。判断错的代价不对称：
 * 标成不可桥接会让一个能用的节点被永久排除且无从发现，而标成可桥接
 * 最坏是探测时失败一次，那有明确的错误信息。
 */
export function classifyNode(type: string): { direct: boolean; bridgeable: boolean } {
  return { direct: isDirectCapable(type), bridgeable: true };
}
