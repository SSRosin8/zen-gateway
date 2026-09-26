/**
 * OpenCode 项目配置（`opencode.json`）的形状，服务端写文件与后台展示片段共用（纪律 #4）。
 *
 * 两个版本都只覆盖内置 opencode provider 的连接设置。OpenCode 自己维护
 * provider package、模型目录和模型协议适配，网关不应复制或覆盖那份目录。
 * 本文件进浏览器构建，不引入 Node 内置模块。
 */

export type OpenCodeVersion = "1" | "2";
export type OpenCodeShape = "v1" | "v2";

export const RELAY_TOKEN_PLACEHOLDER = "<把配置文件里的 gateway.relayToken 填进来>";

export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

/** 客户端应填的 baseURL。网关只监听回环，所以恒为 127.0.0.1。 */
export function openCodeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

export function shapeOf(version: OpenCodeVersion): OpenCodeShape {
  return version === "1" ? "v1" : "v2";
}

export function createOpenCodeConfig(port: number, version: OpenCodeVersion, apiKey: string) {
  const settings = { baseURL: openCodeBaseUrl(port), apiKey };

  if (version === "1") {
    return {
      $schema: OPENCODE_SCHEMA_URL,
      provider: { opencode: { options: settings } },
    };
  }

  return {
    $schema: OPENCODE_SCHEMA_URL,
    providers: { opencode: { settings } },
  };
}

export function openCodeConfigSnippet(
  port: number,
  version: OpenCodeVersion,
  apiKey: string = RELAY_TOKEN_PLACEHOLDER,
): string {
  return JSON.stringify(createOpenCodeConfig(port, version, apiKey), null, 2);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 两种形状下连接设置所在的路径：v1 `provider.opencode.options`，v2 `providers.opencode.settings`。 */
const PATHS: Record<OpenCodeShape, readonly [string, string, string]> = {
  v1: ["provider", "opencode", "options"],
  v2: ["providers", "opencode", "settings"],
};

/** 文件里已有哪种形状的 opencode provider。两种都有或都没有时返回 null，由调用方决定。 */
export function existingShape(doc: JsonObject): OpenCodeShape | null {
  const has = (shape: OpenCodeShape) => {
    const [a, b] = PATHS[shape];
    const top = doc[a];
    return isObject(top) && top[b] !== undefined;
  };
  const v1 = has("v1");
  const v2 = has("v2");
  if (v1 === v2) return null;
  return v1 ? "v1" : "v2";
}

/** 读出某形状下的 baseURL/apiKey；缺失或类型不对时对应字段为 null。 */
export function readOpenCodeSettings(
  doc: JsonObject,
  shape: OpenCodeShape,
): { baseURL: string | null; apiKey: string | null } {
  let node: unknown = doc;
  for (const key of PATHS[shape]) {
    node = isObject(node) ? node[key] : undefined;
  }
  if (!isObject(node)) return { baseURL: null, apiKey: null };
  return {
    baseURL: typeof node["baseURL"] === "string" ? node["baseURL"] : null,
    apiKey: typeof node["apiKey"] === "string" ? node["apiKey"] : null,
  };
}

/**
 * 只设置 opencode provider 的 baseURL/apiKey，保留其余全部键。路径上已有非对象值时返回
 * 失败而不是覆盖：那是用户写的东西，改成对象会丢数据。
 */
export function applyOpenCodeSettings(
  doc: JsonObject,
  shape: OpenCodeShape,
  settings: { baseURL: string; apiKey: string },
): { ok: true; doc: JsonObject } | { ok: false; reason: string } {
  const next = structuredClone(doc);
  let node: JsonObject = next;
  for (const key of PATHS[shape]) {
    const child = node[key];
    if (child === undefined) {
      node[key] = {};
    } else if (!isObject(child)) {
      return { ok: false, reason: `${PATHS[shape].join(".")} 路径上的 ${key} 不是对象` };
    }
    node = node[key] as JsonObject;
  }
  node["baseURL"] = settings.baseURL;
  node["apiKey"] = settings.apiKey;
  return { ok: true, doc: next };
}

/** `opencode --version` 输出（如 `opencode v2.0.12`）的主版本号；认不出为 null。 */
export function majorOf(version: string): number | null {
  const m = /v?(\d+)\./.exec(version);
  return m === null ? null : Number(m[1]);
}

/** 按主版本选配置格式：1 → 1.x 形状，其余（含探测不到）→ 2.x 形状。 */
export function versionFor(detected: string | null): OpenCodeVersion {
  return detected !== null && majorOf(detected) === 1 ? "1" : "2";
}
