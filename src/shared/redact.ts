/**
 * 脱敏：「哪些东西算凭证」的唯一定义（纪律 #4）。
 *
 * 宁可过度脱敏：键名按归一化后的子串匹配凭证词，精确名单追不上字段名变体。
 * 只有字符串值会被脱敏，`inputTokens` 这类数值用量字段不受影响。
 */

const REDACTED = "[已脱敏]";

/** 键名里出现即视为凭证的词根（归一化后比对：小写、去掉 `-_ .`）。 */
const SECRET_KEY_SUBSTRINGS = [
  "key", // apikey / xapikey / relaykey / privatekey / accesskey / secretkey
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "cookie",
  "authorization",
  "bearer",
  "psk",
  "sessionid",
];

/** 键名等于这些时也视为凭证(太短,不适合做子串)。 */
const SECRET_KEY_EXACT = new Set(["auth", "pass", "pwd", "uuid"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, "");
}

export function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SECRET_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_SUBSTRINGS.some((word) => k.includes(word));
}

/**
 * 只保留 scheme 与 host，path 与 query 一律丢掉：订阅 URL 的 token 常在其中，
 * 而这里无法可靠区分哪个 URL 藏着 token。
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
 * 把 ASCII 控制字符（0x00-0x1F 与 0x7F）换成空格。逐码点判断而非正则字符类，
 * 避免源码里出现不可见的控制字节。
 */
function stripControlChars(input: string): string {
  let out = "";
  for (const ch of input) out += isControlCode(ch.codePointAt(0) ?? 0) ? " " : ch;
  return out;
}

/** ASCII 控制字符（0x00-0x1F 与 0x7F）。`schema.ts` 的凭证校验共用这一判定。 */
export function isControlCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/**
 * 扫描前的输入上限，防止长文本回溯卡住单线程网关；与输出上限 `maxLength` 无关。
 * 先截断再脱敏是安全的：kv 规则的值部分贪婪匹配到末尾，截断的凭证前缀仍被替换。
 */
const MAX_SCAN_LENGTH = 8_192;

/**
 * 形如 `apiKey: xxx` / `"token":"xxx"` / `secret => xxx` 的键值对，键名容忍连字符、
 * 下划线、空格。`=>` 必须排在 `[:=]` 之前，否则只吃掉 `=` 而留下 `>` 与值。
 */
const KV_PATTERN = new RegExp(
  String.raw`((?:api|access|relay|private|secret|client|bearer|session|x[-_ ]?oc[-_ ]?relay|x[-_ ]?api)?` +
    String.raw`[-_ ]?(?:key|secret|token|password|passwd|credentials?|cookie|authorization|psk))` +
    String.raw`(\s*["']?\s*(?:=>|[:=])\s*["']?)` +
    String.raw`([^\s,;"'}\]&]+)`,
  "gi",
);

/** 文本里的 Bearer / key= / :password@ 等形态。 */
export function redactText(input: string, maxLength = 500): string {
  const scanned = input.length > MAX_SCAN_LENGTH ? input.slice(0, MAX_SCAN_LENGTH) : input;

  const out = stripControlChars(
    scanned
      // URL 内嵌凭证放在最前：后面的规则会把它切碎而漏掉。scheme 长度有界以免回溯。
      .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, `$1${REDACTED}@`)
      .replace(/\b(bearer|basic)\s+[\w.\-+/=]+/gi, `$1 ${REDACTED}`)
      .replace(KV_PATTERN, `$1$2${REDACTED}`)
      // Zen key 的常见前缀形态。
      .replace(/\b(sk|zen)[-_][A-Za-z0-9\-_]{8,}/g, REDACTED),
  );

  const truncated = input.length > MAX_SCAN_LENGTH;
  const body = out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
  return truncated ? `${body}[已截断]` : body;
}

/** 把容器类对象转成可递归的普通结构；Object.entries 对它们只会得到 {}。 */
function unwrapContainer(value: object): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactUrl(value.href);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof RegExp) return value.source;
  return null;
}

/** 递归脱敏任意结构，用于日志/快照/错误。深度与体积有上限，避免畸形对象栈溢出。 */
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
    const unwrapped = unwrapContainer(value);
    if (unwrapped !== null) return redactValue(unwrapped, depth + 1);

    const out: Record<string, unknown> = {};
    // getter 可能抛出带裸凭证的错误，redactText 认不出，因此不回显消息。
    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(value as Record<string, unknown>);
    } catch {
      return { "[读取属性失败]": true };
    }

    for (const [k, v] of entries) {
      if (isSecretKey(k)) {
        // 只有字符串可能是凭证，数值用量字段原样保留。
        if (typeof v === "number" || typeof v === "boolean") {
          out[k] = v;
          continue;
        }
        // 保留「有没有值」：key 为空与 key 配错是不同的故障。
        out[k] = v === "" ? "" : REDACTED;
        continue;
      }
      if (/url$/i.test(k) && typeof v === "string") {
        out[k] = redactUrl(v);
        continue;
      }
      try {
        out[k] = redactValue(v, depth + 1);
      } catch {
        // 同上：不回显 getter 抛出的消息。
        out[k] = "[读取失败]";
      }
    }
    return out;
  }

  return REDACTED;
}

/** 跟随 `cause` 链的层数上限；足以覆盖 `fetch failed` → undici → `ErrnoException`。 */
const MAX_CAUSE_DEPTH = 3;

/** 整条 cause 链拼接后的字符上限，否则四层各 500 字会把单行日志抬到 2000。 */
const MAX_CAUSE_CHAIN_LENGTH = 800;

/**
 * 任何异常 → 一行安全文本。跟随有界的 `cause` 链（纪律 #8）：undici 把底层故障
 * 包成 `fetch failed`，真正原因（如证书链错误）只在 cause 里。每层各自过 `redactText`。
 */
export function safeErrorMessage(err: unknown): string {
  const parts: string[] = [];
  // 环保护：外部设置的 `cause` 可能自引用或互引用。
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }

    let text: string;
    if (current instanceof Error) {
      text = redactText(current.message);
    } else if (typeof current === "string") {
      text = redactText(current);
    } else {
      // 非 Error 的 cause 只在首层时报「未知错误」；作为下层原因不提供信息。
      if (depth === 0) return "未知错误";
      break;
    }

    // 空消息不占位；全空时由循环后的兜底回一句话。
    if (text !== "") parts.push(text);

    if (!(current instanceof Error)) break;
    const next: unknown = (current as Error & { cause?: unknown }).cause;
    if (next === undefined) break;
    current = next;
  }

  if (parts.length === 0) return "未知错误";
  // ← 左边是表象、右边是原因。各层已去掉 CR/LF，拼接不会引入换行。
  const joined = parts.join(" ← ");
  return joined.length > MAX_CAUSE_CHAIN_LENGTH
    ? `${joined.slice(0, MAX_CAUSE_CHAIN_LENGTH)}…`
    : joined;
}
