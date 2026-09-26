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
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\boc_sk_[A-Za-z0-9_-]{20,}\b/,
];

// 上游重验需要一个能通过格式检查的坏 key。只豁免这一个精确字面量；其他
// `oc_sk_` 值仍必须被报告，不能按含有 fake 等词做宽泛放行。
const KNOWN_FAKE_SECRETS = ["oc_sk_0000_obviously_fake_not_a_real_key"];

// 守卫自身与它的行为测试必须包含这些虚构格式，不能被自身扫描结果污染。
const SELF_FILES = new Set(["scripts/check-sensitive-files.mjs", "tests/unit/sensitiveFiles.test.ts"]);

export function forbiddenPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized));
}

export function secretPattern(line) {
  const candidate = KNOWN_FAKE_SECRETS.reduce((text, secret) => text.replaceAll(secret, ""), line);
  return HIGH_CONFIDENCE_SECRET_PATTERNS.findIndex((pattern) => pattern.test(candidate)) >= 0;
}

export function inspectPaths(paths) {
  return paths.filter(forbiddenPath);
}

export function inspectText(path, text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (secretPattern(lines[index] ?? "")) hits.push({ path, line: index + 1 });
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
  for (const hit of result.contentHits) console.error(`高置信凭证格式：${hit.path}:${hit.line}`);
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
