import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenCodeView } from "../../shared/contract.ts";
import {
  applyOpenCodeSettings,
  createOpenCodeConfig,
  existingShape,
  openCodeBaseUrl,
  majorOf,
  readOpenCodeSettings,
  shapeOf,
  versionFor,
  type OpenCodeShape,
  type OpenCodeVersion,
} from "../../shared/openCodeConfig.ts";
import { atomicWriteFile } from "../../store/atomicWrite.ts";
import { safeErrorMessage } from "../../shared/redact.ts";

/**
 * 项目根下 `opencode.json` 的检测与写入。文件含真实 Relay Token：0600、原子写，
 * 已有文件只改 opencode provider 的 baseURL/apiKey；解析不了（JSONC、注释）就不碰。
 */

export const OPENCODE_FILE = "opencode.json";

const VERSION_TIMEOUT_MS = 5_000;

/** 探测 `opencode --version`；未安装、超时或输出认不出都返回 null。不经 shell。 */
export type VersionProbe = () => Promise<string | null>;

export const probeOpenCodeVersion: VersionProbe = () =>
  new Promise((resolve) => {
    execFile("opencode", ["--version"], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err !== null) return resolve(null);
      const text = String(stdout).trim().split("\n")[0]?.slice(0, 64) ?? "";
      resolve(majorOf(text) === null ? null : text);
    });
  });

/** 从版本串取主版本号；认不出返回 null。 */

type Loaded =
  | { kind: "missing" }
  | { kind: "json"; doc: Record<string, unknown> }
  | { kind: "unwritable"; reason: string };

async function load(file: string): Promise<Loaded> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unwritable", reason: `无法读取:${safeErrorMessage(err)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // 不回显原文：文件里可能有 token。JSONC 的注释与尾逗号也落在这里。
    return { kind: "unwritable", reason: "不是严格 JSON(可能含注释或尾逗号),为免丢失内容不自动改写" };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { kind: "unwritable", reason: "顶层不是对象,不自动改写" };
  }
  return { kind: "json", doc: doc as Record<string, unknown> };
}

function sameSecret(a: string, b: string): boolean {
  // 比哈希而非明文：等长比较，且不因长度不同提前返回。
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type OpenCodeContext = {
  readonly root: string;
  readonly port: number;
  readonly relayToken: string;
  readonly probeVersion: VersionProbe;
};

export async function openCodeView(ctx: OpenCodeContext): Promise<OpenCodeView> {
  const [loaded, detectedVersion] = await Promise.all([
    load(join(ctx.root, OPENCODE_FILE)),
    ctx.probeVersion(),
  ]);
  let shape: OpenCodeShape | null = null;
  let pointsToGateway = false;
  if (loaded.kind === "json") {
    shape = existingShape(loaded.doc);
    if (shape !== null) {
      const s = readOpenCodeSettings(loaded.doc, shape);
      pointsToGateway =
        s.baseURL === openCodeBaseUrl(ctx.port) && s.apiKey !== null && sameSecret(s.apiKey, ctx.relayToken);
    }
  }
  return {
    path: OPENCODE_FILE,
    exists: loaded.kind !== "missing",
    detectedVersion,
    shape,
    pointsToGateway,
    unwritableReason: loaded.kind === "unwritable" ? loaded.reason : null,
  };
}

export type WriteOutcome =
  | { ok: true; action: "created" | "updated" | "unchanged" }
  | { ok: false; reason: string };

/**
 * 写入或更新。`onlyIfMissing` 用于首启自动写：文件已存在就绝不改。
 * 已有文件沿用它现有的形状（用户可能按另一版本写的），没有 opencode provider 时才按版本选。
 */
export async function writeOpenCodeConfig(
  ctx: OpenCodeContext,
  options: { version?: OpenCodeVersion; onlyIfMissing?: boolean } = {},
): Promise<WriteOutcome> {
  const file = join(ctx.root, OPENCODE_FILE);
  const loaded = await load(file);
  const version = options.version ?? versionFor(await ctx.probeVersion());
  const settings = { baseURL: openCodeBaseUrl(ctx.port), apiKey: ctx.relayToken };

  let body: Record<string, unknown>;
  let action: "created" | "updated";
  if (loaded.kind === "missing") {
    body = createOpenCodeConfig(ctx.port, version, ctx.relayToken);
    action = "created";
  } else if (options.onlyIfMissing === true) {
    return { ok: true, action: "unchanged" };
  } else if (loaded.kind === "unwritable") {
    return { ok: false, reason: loaded.reason };
  } else {
    const shape = options.version !== undefined ? shapeOf(version) : (existingShape(loaded.doc) ?? shapeOf(version));
    const applied = applyOpenCodeSettings(loaded.doc, shape, settings);
    if (!applied.ok) return { ok: false, reason: applied.reason };
    body = applied.doc;
    action = "updated";
  }

  try {
    // 新建时独占：检查与写入之间文件被创建，也不覆盖它。
    await atomicWriteFile(file, `${JSON.stringify(body, null, 2)}\n`, { exclusive: action === "created" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return options.onlyIfMissing === true
        ? { ok: true, action: "unchanged" }
        : { ok: false, reason: "文件在写入期间被创建,已放弃;请重试" };
    }
    return { ok: false, reason: `写入失败:${safeErrorMessage(err)}` };
  }
  return { ok: true, action };
}
