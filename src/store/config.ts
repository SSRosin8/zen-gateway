import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_VERSION, ConfigSchema, type Config } from "../shared/schema.ts";
import { safeErrorMessage } from "../shared/redact.ts";

/**
 * 配置的加载与持久化。
 *
 * config.json 里有 Zen API key、Relay Token、代理口令、Clash secret ——
 * 整个文件都是凭证。因此：0600 权限、原子写、且任何失败路径都不回显文件内容。
 */

/** 文件权限：只有属主可读写。data/ 目录同理用 0700。 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function dataDir(root: string = process.cwd()): string {
  return resolve(root, "data");
}

export function configPath(root: string = process.cwd()): string {
  return join(dataDir(root), "config.json");
}

/** 首启生成的 Relay Token：32 字节 → 43 个 URL-safe 字符。 */
export function generateRelayToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 配置错误。
 *
 * 刻意不用构造器参数属性（`constructor(readonly kind: ...)`）：
 * Node 的 strip-only TypeScript 模式不支持那个语法，而 scripts/*.mjs
 * 要直接 import 本模块来复用 schema 与读写逻辑（不复用就会退化成两份
 * 定义，迁移脚本写出的配置迟早与 schema 不一致）。tsc 不会拦这个 ——
 * 只有真正跑脚本时才炸。
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
 * 版本闸门 + 迁移钩子。
 *
 * 目前只有 version 1，没有需要搬的形状。保留这一层是因为格式**会**演进：
 * 「加字段」不升版本（schema 的默认值兜住），「改语义或改形状」才升版本，
 * 届时在这里逐档递进。
 *
 * 本项目是全新实现，不从任何旧项目导入配置 —— 缺 version 字段就是配置坏了，
 * 不是「来自某个更早的格式」。
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
};

/**
 * 加载配置；文件不存在则生成默认配置并写盘。
 *
 * 只有「文件不存在」会自动创建。文件存在但读不动、解析不了、校验不过时
 * 一律抛错 —— 那种情况下自动覆盖会把用户的配置连同凭证一起丢掉。
 */
export async function loadConfig(root: string = process.cwd()): Promise<LoadResult> {
  const file = configPath(root);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const config = defaultConfig();
      await saveConfig(config, root);
      return { config, created: true };
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
    /*
     * 绝不把 text 或 JSON.parse 的原始消息放进错误。
     * V8 的 JSON 报错会带上出错位置附近的原文片段,而这个文件里
     * 每一行都可能是凭证 —— 那片段会进日志、进终端、进用户粘贴的报错。
     * 只给位置,让人自己去看文件。
     */
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
      // detail 与 message 同源,单独留一份供结构化日志用。
      formatIssues(parsed.error),
    );
  }

  // 文件可能是别的工具或手工创建的,权限不一定对。
  await ensureFileMode(file);

  return { config: parsed.data, created: false };
}

/** 权限不对就修正，而不是只警告 —— 警告会被忽略，凭证不该赌这个。 */
async function ensureFileMode(file: string): Promise<void> {
  try {
    const st = await stat(file);
    if ((st.mode & 0o777) !== FILE_MODE) await chmod(file, FILE_MODE);
  } catch {
    // 改不动权限不该阻塞启动；doctor 会单独报这一项。
  }
}

/**
 * 原子写。
 *
 * 先写同目录临时文件 → fsync → rename。
 * - 同目录是必须的：跨文件系统 rename 不是原子操作。
 * - fsync 在 rename 之前：否则崩溃后可能 rename 出一个内容为空的文件,
 *   而这个文件是唯一一份凭证存储。
 * - 临时文件一出生就是 0600,不存在「先 0644 再 chmod」的窗口。
 */
export async function saveConfig(config: Config, root: string = process.cwd()): Promise<void> {
  // 写之前必过 schema：避免代码里某处构造了非法配置,写盘后下次启动才炸。
  const validated = ConfigSchema.parse(config);

  const file = configPath(root);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });

  const temp = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const body = `${JSON.stringify(validated, null, 2)}\n`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", FILE_MODE);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw new ConfigError(`无法写入 ${file}：${safeErrorMessage(err)}`, "unreadable");
  }

  // 目录项也要落盘,否则崩溃后 rename 可能丢失。
  await syncDir(dir);
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 某些文件系统不支持对目录 fsync；不是致命错误。
  }
}

export async function configExists(root: string = process.cwd()): Promise<boolean> {
  try {
    await access(configPath(root), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
