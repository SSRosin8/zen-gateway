/**
 * 订阅体解析(纯函数,不发请求)。订阅格式由第三方决定且随时会变,须能拿文本反复喂。
 *
 * 支持:Clash YAML/JSON(`proxies:`)、SIP008(`servers:`)、分享链列表、多层 Base64 外壳
 * (实测存在双层编码,上限 3 层防止无限自我解码)。
 * 文本完全不可信:失败绝不把原文放进错误(ss:// 的 userinfo 就是密码);条目数有上限;
 * 能否直连归 `isDirectCapable` 判定,这里只带出原始协议名。
 */

import { parse as parseYaml } from "yaml";
import { isGroupType } from "../../../shared/clashNodeTypes.ts";
import { isDirectCapable } from "../dispatcher.ts";

/**
 * 解析出来的一个节点,刻意不是 `Proxy`:`id` 与 `subscriptionId` 不是文本内容的一部分,
 * 组装成 `Proxy` 由 `importSubscriptionNodes` 负责。
 */
export type ParsedNode = {
  readonly name: string;
  /** 原始协议名,小写。可能是 `vless`/`hysteria2` 这类只能桥接的类型。 */
  readonly type: string;
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
};

export type SubscriptionFormat = "clash" | "sip008" | "uri-list" | "empty";

/**
 * Clash 配置里顺带给出的本机信息,只是提示:真在跑的内核端口以 Controller `/configs` 为准,
 * 这些字段只用于填表单默认值,不能直接拿来配桥接。
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
  /** 认出了形态但某些条目不合法(缺 host/端口越界)时的丢弃数。 */
  readonly skipped: number;
  readonly hints?: ClashHints;
};

/** 单个订阅最多接受的节点数。 */
export const MAX_NODES = 2000;

/** Base64 最多解几层。 */
const MAX_BASE64_DEPTH = 3;

/** 只能经 Clash 桥接的隧道协议,只用于认识分享链的 scheme。 */
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

// ---- 基础解码 ----

/**
 * 宽松 Base64 解码(兼容 URL-safe 与缺省填充)。返回 `null` 表示不是 base64,供形态判定。
 * 解出含控制字符算失败,否则任意二进制都会变成垃圾节点名。
 */
function decodeBase64(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (cleaned === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  // 过短的「base64」几乎必然是误判(3 字母的节点名也会命中上面的正则)。
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

/** 分享链的 `#备注` 段是 percent-encoded 的,`+` 也要当空格。 */
function decodeLabel(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    // 名字是展示用的,坏转义不该丢掉整个节点。
    return value;
  }
}

/** 看起来已经是结构化文本(YAML/JSON)或链接列表了吗? */
function looksDecoded(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if (/^(?:proxies|servers|mixed-port|port|socks-port)\s*:/m.test(t)) return true;
  return /^[a-z][a-z0-9+.-]*:\/\//im.test(t);
}

/** 逐层解开 Base64 外壳:已像结构化文本、解不出、解出与原文相同时停止。 */
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

// ---- 端点与字段提取 ----

function validPort(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const port = Math.floor(n);
  return port >= 1 && port <= 65535 ? port : null;
}

/** 解析 `host:port`,含 IPv6 的 `[::1]:443` 形态。 */
function parseEndpoint(value: string): { host: string; port: number } | null {
  const raw = value.trim();
  if (raw.startsWith("[")) {
    const m = /^\[([^\]]+)]:(\d+)$/.exec(raw);
    if (m === null) return null;
    const port = validPort(m[2]);
    return port === null || m[1] === undefined || m[1] === "" ? null : { host: m[1], port };
  }
  // 用 lastIndexOf:裸 IPv6 没有方括号时前面的冒号都属于地址。
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

// ---- Clash YAML / SIP008 ----

function clashItem(item: Record<string, unknown>): ParsedNode | null {
  const host = firstString(item.server, item.host);
  const port = validPort(item.port ?? item.server_port);
  if (host === undefined || port === null) return null;

  const type = firstString(item.type) ?? "http";
  // 分组混进 `proxies:` 是实测存在的形态,见 `clashNodeTypes.ts`。
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
    // SIP008 的 `method` 是加密方式,放在 username 位只为不丢信息。
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
    // `external-controller` 常写成 `127.0.0.1:9090`(没有 scheme)。
    hints.externalController = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  const groups = doc["proxy-groups"];
  if (Array.isArray(groups)) {
    const names = groups.flatMap((g) => {
      if (g === null || typeof g !== "object") return [];
      const group = g as Record<string, unknown>;
      const type = firstString(group.type) ?? "";
      const name = firstString(group.name);
      // 只收 `select`:只有它能被 Controller 切换。
      return type.toLowerCase() === "select" && name !== undefined ? [name] : [];
    });
    if (names.length > 0) hints.selectorGroups = names;
  }

  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** 解析结构化文本(YAML 是 JSON 的超集);返回 `null` 表示不是结构化形态。 */
function parseStructured(
  text: string,
): { nodes: ParsedNode[]; skipped: number; format: "clash" | "sip008"; hints?: ClashHints } | null {
  let doc: unknown;
  try {
    doc = parseYaml(text, {
      // 防 YAML 锚点展开放大(billion laughs)。
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

// ---- 分享链 ----

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

/** `ss://` 有两种写法:整体 base64、或 `base64(method:pass)@host:port`,都要认。 */
function parseShadowsocks(payload: string): ParsedNode | null {
  const hash = payload.indexOf("#");
  const label = hash >= 0 ? decodeLabel(payload.slice(hash + 1)) : "";
  let main = hash >= 0 ? payload.slice(0, hash) : payload;
  main = main.split("?")[0] ?? main;

  // 整体编码的形态:解开之后才有 `@`。
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

/** `http(s)://` 与 `socks…://`,交给 WHATWG URL 解析。 */
function parseStandard(raw: string, scheme: string): ParsedNode | null {
  try {
    // `socks5h` 先归一为 socks5。
    const normalized = scheme === "socks5h" ? `socks5://${raw.slice(raw.indexOf("://") + 3)}` : raw;
    const url = new URL(normalized);
    if (url.hostname === "") return null;
    const port =
      url.port === "" ? (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80) : validPort(url.port);
    if (port === null) return null;
    const type = scheme === "socks" || scheme === "socks5h" ? "socks5" : scheme === "socks4a" ? "socks4" : scheme;
    return node(
      type,
      // `URL.hostname` 对 IPv6 带方括号,配置里存裸地址。
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

/** 其余隧道协议:`scheme://userinfo@host:port?params#label`。 */
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
 * 解析一条分享链。不认识的 scheme 返回 `null` 而不是硬塞成 http:猜错协议会造出走错路的代理。
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

// ---- 入口 ----

/**
 * 解析一个订阅体。绝不抛错:任何形态都只得到「解出 0 个节点」,
 * 上层才能区分「拉取失败」与「拉到了但解不出」。
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

  // 按行切而不是按空白切:节点名里可能有未编码的空格。
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
 * 这个节点能不能用。`direct` 走 `isDirectCapable`(唯一真相)。`bridgeable` 恒为 true:
 * 协议内核认不认只有内核知道,标成不可桥接会永久排除能用的节点,标错最坏只是探测失败一次。
 */
export function classifyNode(type: string): { direct: boolean; bridgeable: boolean } {
  return { direct: isDirectCapable(type), bridgeable: true };
}
