#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** 文件名本身就是敏感信息的高置信集合。 */
export const FORBIDDEN_PATHS = [
  /^(?:|.*\/)\.env(?:rc)?(?:\..*)?$/,
  /^(?:|.*\/)opencode\.jsonc?$/,
  /^(?:|.*\/)(?:data|backups?|private|secrets)(?:\/|$)/,
  /^(?:|.*\/)(?:backup|backups?)(?:[._-].*)?$/i,
  /^(?:|.*\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i,
  /\.(?:bak|backup|dump|db|sqlite|sqlite3|pem|key|crt|cer|p12|pfx|jks|der)(?:[-.]?(?:wal|shm))?$/i,
];

/** 只认公开凭证格式，避免把虚构 fixture 与字段名误报成秘密。 */
export const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\boc_sk_[A-Za-z0-9_-]{20,}\b/,
];

// 上游重验需要一个能通过格式检查的坏 key。只豁免这一个精确字面量；其他
// `oc_sk_` 值仍必须被报告，不能按含有 fake 等词做宽泛放行。
const KNOWN_FAKE_SECRETS = ["oc_sk_0000_obviously_fake_not_a_real_key"];

/*
 * 以下是隐私启发式：不是凭证格式，而是"不该出现在公开仓库里"的个人或网络信息。
 * 放行规则刻意写成精确值或保留地址段，不按"含 fake 字样"放宽，
 * 目标是当前树零误报、新增真实值必报。
 */

/** 足够长的 Bearer 字面量；短 fixture 与 `<占位符>` 不命中，含虚构标记的放行。 */
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/=-]{32,})/g;
const FAKE_MARKER = /fake|not-?real|example|placeholder|dummy/i;

/** `/home/<name>/`、`/Users/<name>/`；只放行通用占位名。 */
const HOME_PATH = /(?:\/home|\/Users)\/([A-Za-z0-9._-]+)/g;
const GENERIC_HOME_NAMES = new Set(["someone", "user", "username", "name", "me", "you", "runner", "example", "alice", "bob"]);

const EMAIL = /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g;
const ALLOWED_EMAILS = new Set(["noreply@anthropic.com"]);
const ALLOWED_EMAIL_DOMAIN = /(?:^|\.)(?:users\.noreply\.github\.com|example(?:\.(?:com|org|net))?|invalid|test|localhost)$/i;

const IPV4 = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])(\/\d{1,2})?/g;
/**
 * 通用放行的精确值：公共 DNS 与约定俗成的示例地址。新增前先考虑能否改用
 * 文档保留段 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24。
 */
// 测试与文档里固定使用的示例值；新增示例从这里登记，不按目录整段放行私网地址。
const ALLOWED_IPV4 = new Set([
  "0.0.0.0", "255.255.255.255", "1.1.1.1", "8.8.8.8", "1.2.3.4",
  "10.0.0.1", "10.1.2.3", "10.9.8.7", "10.20.30.40", "192.168.1.1",
]);
/** 按文件放行的边界值：地址分类器的测试需要紧贴回环段两侧的真实地址。 */
const ALLOWED_IPV4_BY_FILE = new Map([["tests/unit/middleware.test.ts", new Set(["126.255.255.255", "128.0.0.1"])]]);

function octets(ip) {
  const parts = ip.split(".");
  // 前导零与越界值不是合法地址（常见于解析器的负例 fixture），不参与判定。
  if (parts.some((p) => (p.length > 1 && p.startsWith("0")) || Number(p) > 255)) return null;
  return parts.map(Number);
}

function isDocumentationOrLoopback([a, b, c]) {
  return a === 127 || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function isPrivate([a, b]) {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function ipv4Finding(path, line) {
  for (const m of line.matchAll(IPV4)) {
    const ip = m[1];
    const o = octets(ip);
    if (o === null || isDocumentationOrLoopback(o) || ALLOWED_IPV4.has(ip)) continue;
    // 私网段只在 CIDR 规则示例（`10.0.0.0/8`）里放行；具体私网地址要先登记为示例值。
    if (isPrivate(o) && m[2] !== undefined) continue;
    if (ALLOWED_IPV4_BY_FILE.get(path)?.has(ip)) continue;
    return true;
  }
  return false;
}

/** 机场节点名：国旗 emoji + 线路标记，同一行还带着非虚构域名。 */
const FLAG = /\p{Regional_Indicator}{2}/u;
const LINE_MARKER = /IPLC|IEPL|VIP\d/;
// 只认常见顶级域：源码里的 `r.nodes` 这类属性访问在形状上也像域名。
const DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|cc|me|xyz|top|cloud|dev|app|co|info|link|site|online|club|vip|pro|cn|hk|jp|us|sg|tw|uk|de|ru|invalid|example|test|localhost)\b/gi;

function airportNode(line) {
  if (!FLAG.test(line) || !LINE_MARKER.test(line)) return false;
  return [...line.matchAll(DOMAIN)].some((m) => !/(?:^|\.)(?:invalid|example|test|localhost)$|(?:^|\.)example\.(?:com|org|net)$/i.test(m[0]));
}

/** 逐行判定，返回命中的类别；未命中返回 null。 */
export function lineFinding(path, line) {
  const candidate = KNOWN_FAKE_SECRETS.reduce((text, secret) => text.replaceAll(secret, ""), line);
  if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(candidate))) return "高置信凭证格式";
  if ([...line.matchAll(BEARER)].some((m) => !FAKE_MARKER.test(m[1]))) return "Bearer 凭证字面量";
  if ([...line.matchAll(HOME_PATH)].some((m) => !GENERIC_HOME_NAMES.has(m[1]))) return "个人主目录路径";
  if ([...line.matchAll(EMAIL)].some((m) => !ALLOWED_EMAILS.has(m[0]) && !ALLOWED_EMAIL_DOMAIN.test(m[1]))) {
    return "非占位邮箱";
  }
  if (ipv4Finding(path, line)) return "非保留 IPv4 地址";
  if (airportNode(line)) return "疑似真实节点名";
  return null;
}

// 守卫自身必须包含这些规则与放行值，不能被自身扫描结果污染。行为测试的旧 index
// 版本含字面量样例，所以也不走仓库扫描；它的工作树内容由测试直接用 inspectText 自检。
export const SELF_FILES = new Set(["scripts/check-sensitive-files.mjs", "tests/unit/sensitiveFiles.test.ts"]);

export function forbiddenPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized));
}

export function inspectPaths(paths) {
  return paths.filter(forbiddenPath);
}

export function inspectText(path, text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    const kind = lineFinding(path, lines[index] ?? "");
    if (kind !== null) hits.push({ path, line: index + 1, kind });
  }
  return hits;
}

export function repositoryPaths(root = ROOT) {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
    encoding: "utf8",
    },
  );
  return [...new Set(output.split("\0").filter(Boolean))];
}

export function run(root = ROOT) {
  const paths = repositoryPaths(root);
  const indexed = new Set(
    execFileSync("git", ["-C", root, "ls-files", "--cached", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  );
  const pathHits = inspectPaths(paths);
  const contentHits = [];
  for (const path of paths) {
    if (forbiddenPath(path) || SELF_FILES.has(path)) continue;
    // 同时检查 index 与工作树：前者覆盖 staged 内容，后者避免未 staged 的真实
    // 凭证在本地开发时被 `validate` 忽略。两份结果按路径/行号去重。
    const texts = [];
    if (indexed.has(path)) {
      texts.push(execFileSync("git", ["-C", root, "show", `:${path}`], { encoding: "utf8" }));
    }
    try {
      texts.push(readFileSync(resolve(root, path), "utf8"));
    } catch {
      // 工作树中被删除但仍在 index 的文件已经由上面的内容检查覆盖。
    }
    contentHits.push(...texts.flatMap((text) => inspectText(path, text)));
  }
  const unique = new Map(contentHits.map((hit) => [`${hit.path}:${hit.line}`, hit]));
  return { pathHits, contentHits: [...unique.values()], checked: paths.length };
}

function report(result) {
  if (result.pathHits.length === 0 && result.contentHits.length === 0) return true;
  for (const path of result.pathHits) console.error(`禁止提交的敏感路径：${path}`);
  for (const hit of result.contentHits) console.error(`${hit.kind}：${hit.path}:${hit.line}`);
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--fixture-json") {
    const fixture = JSON.parse(readFileSync(0, "utf8"));
    const path = typeof fixture.path === "string" ? fixture.path : "fixture.ts";
    const text = typeof fixture.text === "string" ? fixture.text : "";
    const result = {
      pathHits: forbiddenPath(path) ? [path] : [],
      contentHits: forbiddenPath(path) ? [] : inspectText(path, text),
      checked: 1,
    };
    process.exit(report(result) ? 0 : 1);
  }
  const result = run();
  if (report(result)) {
    console.log(`敏感文件关卡通过：检查 ${result.checked} 个仓库文件`);
    process.exit(0);
  }
  process.exit(1);
}
