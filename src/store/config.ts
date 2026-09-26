import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath, dataDir, DIR_MODE, FILE_MODE } from "./paths.ts";
import { atomicWriteFile } from "./atomicWrite.ts";
import { CONFIG_VERSION, ConfigSchema, type Config } from "../shared/schema.ts";
import { safeErrorMessage } from "../shared/redact.ts";

/**
 * 配置的加载与持久化。整个 config.json 都是凭证：0600 权限、原子写、
 * 任何失败路径都不回显文件内容。
 */

/**
 * 转出 `paths.ts` 的实现，供既有调用方沿用本模块路径。先 import 再 export：
 * 本文件内部也用 `configPath`，纯 re-export 不会把名字带进作用域。
 */
export { dataDir, configPath };

/** 首启生成的 Relay Token：32 字节 → 43 个 URL-safe 字符。 */
export function generateRelayToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 配置错误。不用构造器参数属性：`scripts/*.mjs` 以 Node strip-only 模式直接
 * import 本模块，tsc 不会拦这种语法。
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /** 供 doctor 分层诊断用的稳定分类，不要拿去给用户看原始值。 */
  readonly kind: "unreadable" | "malformed" | "invalid" | "permission";
  readonly detail: string | undefined;

  constructor(
    message: string,
    kind: "unreadable" | "malformed" | "invalid" | "permission",
    detail?: string,
  ) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

export function defaultConfig(): Config {
  // 其余字段全部走 schema 的 default，避免默认值有两处定义。
  return ConfigSchema.parse({
    version: CONFIG_VERSION,
    gateway: { relayToken: generateRelayToken() },
  });
}

/**
 * 版本闸门。加字段不升版本，改语义或形状才升并在这里迁移。
 * 缺 version 字段就是配置坏了，不猜测补全。
 */
function checkVersion(raw: Record<string, unknown>): Record<string, unknown> {
  const version = raw["version"];

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ConfigError(
      "配置缺少合法的 version 字段（应为 ≥1 的整数）",
      "invalid",
    );
  }

  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      `配置版本 ${version} 高于本程序支持的 ${CONFIG_VERSION}，请升级 zen-gateway 而不是降级配置`,
      "invalid",
    );
  }

  return raw;
}

/** 校验失败时把 zod 的 issue 列成人可读的行；只含路径与规则，不含值。 */
function formatIssues(error: unknown): string {
  if (!(error instanceof Error) || !("issues" in error)) return safeErrorMessage(error);
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (!Array.isArray(issues)) return safeErrorMessage(error);

  return issues
    .slice(0, 20)
    .map((i) => {
      const path = i.path.length > 0 ? i.path.map(String).join(".") : "(根)";
      // i.message 来自我们自己写的 schema 文案，不含用户数据。
      return `  ${path}: ${i.message}`;
    })
    .join("\n");
}

export type LoadResult = {
  config: Config;
  /** true 表示文件原先不存在，已生成默认配置（含新 Relay Token）。 */
  created: boolean;
  /** 权限与期望值不符的项。仅 `readOnly` 模式下可能非空，正常模式会当场修正。 */
  permissionIssues: readonly string[];
};

export type LoadOptions = {
  /**
   * 只读加载：不修权限、文件不存在时不生成。供 `doctor.mjs` 复用同一套读取与校验
   * （纪律 #4），同时不把该报告的问题悄悄修掉。
   */
  readOnly?: boolean;
};

/**
 * 加载配置；只有文件不存在时生成默认配置并写盘。读不动、解析不了、校验不过
 * 一律抛错，自动覆盖会丢掉用户的凭证。
 */
export async function loadConfig(root?: string, options: LoadOptions = {}): Promise<LoadResult> {
  const file = configPath(root);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.readOnly === true) {
        // 只读模式不生成 —— 生成会带一个新 Relay Token，那是状态变更。
        throw new ConfigError(`${file} 不存在`, "unreadable");
      }
      const config = defaultConfig();
      await saveConfig(config, root);
      return { config, created: true, permissionIssues: [] };
    }
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new ConfigError(`无权读取 ${file}`, "permission");
    }
    throw new ConfigError(`无法读取 ${file}：${safeErrorMessage(err)}`, "unreadable");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // 不回显 JSON.parse 的原始消息：V8 会带上附近的原文片段，可能是凭证。只给位置。
    const position = /position (\d+)/.exec((err as Error).message)?.[1];
    throw new ConfigError(
      `${file} 不是合法 JSON${position ? `（约在第 ${position} 字节）` : ""}`,
      "malformed",
    );
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${file} 的顶层必须是对象`, "malformed");
  }

  const versioned = checkVersion(raw as Record<string, unknown>);

  const parsed = ConfigSchema.safeParse(versioned);
  if (!parsed.success) {
    throw new ConfigError(
      `${file} 校验未通过：\n${formatIssues(parsed.error)}`,
      "invalid",
      formatIssues(parsed.error),
    );
  }

  // 文件可能是手工创建的，权限不一定对。只读模式只查不改。
  if (options.readOnly === true) {
    return { config: parsed.data, created: false, permissionIssues: await checkPermissions(file) };
  }
  await ensurePermissions(file);

  return { config: parsed.data, created: false, permissionIssues: [] };
}

/** 查权限但不改，与 `ensurePermissions` 共用 `FILE_MODE` / `DIR_MODE`。 */
async function checkPermissions(file: string): Promise<string[]> {
  const issues: string[] = [];
  try {
    const st = await stat(file);
    const mode = st.mode & 0o777;
    if (mode !== FILE_MODE) {
      issues.push(`${file} 权限 ${mode.toString(8)}，应为 ${FILE_MODE.toString(8)}`);
    }
  } catch {
    /* 读不到就交给上面的错误分类 */
  }
  try {
    const dir = dirname(file);
    const st = await stat(dir);
    const mode = st.mode & 0o777;
    if (mode !== DIR_MODE) {
      issues.push(`${dir} 权限 ${mode.toString(8)}，应为 ${DIR_MODE.toString(8)}`);
    }
  } catch {
    /* 同上 */
  }
  return issues;
}

/**
 * 权限不对就修正而不是只警告。目录也要修：`mkdir` 的 mode 只在创建时生效，
 * 过松的 data/ 会暴露 runtime.db 与日志。不经 service.mjs 的入口只走这里。
 */
async function ensurePermissions(file: string): Promise<void> {
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== FILE_MODE) await chmod(file, FILE_MODE);
  } catch {
    // 改不动权限不该阻塞启动；doctor 会单独报这一项。
  }
  try {
    const dir = dirname(file);
    const st = await stat(dir);
    if ((st.mode & 0o777) !== DIR_MODE) await chmod(dir, DIR_MODE);
  } catch {
    /* 同上 */
  }
}

/** 写盘前必过 schema，避免非法配置写盘后下次启动才炸。原子写见 `atomicWrite.ts`。 */
export async function saveConfig(config: Config, root?: string): Promise<void> {
  const validated = ConfigSchema.parse(config);

  const file = configPath(root);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mode 只在创建时生效；已存在且过松的目录要纠正。
  await chmod(dir, DIR_MODE).catch(() => {});

  try {
    await atomicWriteFile(file, `${JSON.stringify(validated, null, 2)}\n`);
  } catch (err) {
    throw new ConfigError(`无法写入 ${file}：${safeErrorMessage(err)}`, "unreadable");
  }
}

export async function configExists(root?: string): Promise<boolean> {
  try {
    await access(configPath(root), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
