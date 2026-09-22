/**
 * 脱敏。
 *
 * 凭证会出现在配置校验失败、上游错误、诊断输出、探测快照等很多路径上。
 * 集中在这里是为了让「哪些东西算凭证」只有一份定义 —— 分散判断迟早漏一处，
 * 而漏的那一处通常是日志，也就是最容易被粘贴到别处的地方。
 */

const REDACTED = "[已脱敏]";

/** 值形态的凭证字段名（大小写与分隔符不敏感）。 */
const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "relaytoken",
  "relayaccesstoken",
  "apisecret",
  "secret",
  "password",
  "passwd",
  "token",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "sessionid",
]);

function isSecretKey(key: string): boolean {
  // 去掉所有分隔符后比对，api_key / api-key / apiKey 归一到 apikey。
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ""));
}

/**
 * 订阅 URL 的 token 通常在 query 或 path 里，URL 本身即凭证。
 *
 * 保留 scheme 与 host（诊断时需要知道连的是谁），path 与 query 一律丢掉。
 * 这对 baseUrl 这种非凭证 URL 偏保守（丢了 /zen/v1），但这里无法可靠区分
 * 「哪个 URL 里藏着 token」，宁可诊断信息少一点。
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 连 URL 都不是，不冒险回显任何片段。
    return REDACTED;
  }
  const hasDetail = (url.pathname !== "" && url.pathname !== "/") || url.search !== "";
  // url.host 已含端口；userinfo 在 URL 解析后不在 host 里，但仍防御性剥一次。
  return `${url.protocol}//${url.host.replace(/^.*@/, "")}${hasDetail ? "/…" : ""}`;
}

/**
 * 把 ASCII 控制字符（0x00-0x1F 与 0x7F）换成空格。
 *
 * 用逐码点判断而不是正则字符类：写成正则需要转义序列，而转义序列在
 * 源码里很容易变成真正的控制字节（包括 NUL），那既不可见也难以编辑。
 * 这里字符串最长 500,逐字符的开销无关紧要。
 */
function stripControlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/** 文本里的 Bearer / key= / :password@ 等形态。 */
export function redactText(input: string, maxLength = 500): string {
  const out = stripControlChars(
    input
      // 先处理 URL 内嵌凭证，避免后面的规则把它切碎后漏掉。
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, `$1${REDACTED}@`)
      .replace(/\b(bearer|basic)\s+[\w.\-+/=]+/gi, `$1 ${REDACTED}`)
      .replace(
        /\b(api[-_]?key|secret|token|password|passwd|authorization)\b(\s*[:=]\s*)("?)[^\s,;"']+\3/gi,
        `$1$2${REDACTED}`,
      )
      // Zen key 的常见前缀形态。
      .replace(/\b(sk|zen)[-_][A-Za-z0-9\-_]{8,}/g, REDACTED),
  );

  // 截断放在脱敏之后：先截断可能把一个凭证切成两半而绕过上面的规则。
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/**
 * 递归脱敏任意结构，用于把配置或探测结果放进日志/快照/错误。
 *
 * 深度与体积都设上限：脱敏函数本身不该因为一个畸形的深层对象而栈溢出。
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[层级过深]";

  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) {
        // 保留字段名与「有没有值」，丢掉值本身 ——
        // 「key 是空的」和「key 配错了」是两种不同的故障，诊断时需要能区分。
        out[k] = v === "" ? "" : REDACTED;
        continue;
      }
      if (/url$/i.test(k) && typeof v === "string") {
        out[k] = redactUrl(v);
        continue;
      }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }

  return REDACTED;
}

/** 供错误处理直接使用：任何异常 → 一行安全文本。 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redactText(err.message);
  if (typeof err === "string") return redactText(err);
  return "未知错误";
}
