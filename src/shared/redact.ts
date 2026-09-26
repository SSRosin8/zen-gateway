/**
 * 脱敏。
 *
 * 凭证会出现在配置校验失败、上游错误、诊断输出、探测快照等很多路径上。
 * 集中在这里是为了让「哪些东西算凭证」只有一份定义 —— 分散判断迟早漏一处，
 * 而漏的那一处通常是日志，也就是最容易被粘贴到别处的地方。
 *
 * ## 设计原则:宁可过度脱敏
 *
 * 第一版用「精确字段名白名单」,结果 `x-api-key`、`proxyPassword`、
 * `clashSecret`、`client_secret`、`bearerToken` 等全部漏过 —— 封闭名单
 * 永远追不上真实字段名的变体。现在改为**子串匹配**:归一化后的键名里
 * 只要含凭证词就脱敏。
 *
 * 过度脱敏的代价是诊断信息变少,漏一个凭证的代价是凭证进了日志 ——
 * 两者不对称,所以默认偏向前者。
 *
 * 唯一的例外由「值的类型」兜住:**只有字符串可能是凭证**。
 * `inputTokens: 1234` 这类含 "token" 的数值字段不受影响,
 * 于是用量统计不会被这条规则毁掉。
 */

const REDACTED = "[已脱敏]";

/**
 * 键名里出现即视为凭证的词(归一化后比对:小写、去掉 `-_ .`)。
 *
 * 只列**词根**,靠子串匹配覆盖变体:`secret` 一条就盖住 `apiSecret`、
 * `clashSecret`、`client_secret`、`secretKey`。
 */
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
 */
function stripControlChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out;
}

/**
 * 扫描前的输入上限。
 *
 * 必须有:第一版对纯小写长文本触发了二次回溯 —— 100k 字符耗时 3.4s,
 * 200k 耗时 13s,而这是单线程网关,一个 150k 的上游错误体就能把它卡死。
 * 输入上限与 `maxLength`(输出上限)是两件事,后者截的是结果。
 *
 * 先截断再脱敏是安全的:kv 规则的值部分是贪婪的 `[^\s,;"']+`,
 * 会一直吃到字符串末尾,所以被截断的凭证前缀仍然会被替换掉。
 */
const MAX_SCAN_LENGTH = 8_192;

/**
 * 形如 `apiKey: xxx` / `"token":"xxx"` / `secret => xxx` 的键值对。
 *
 * 键名部分用与 isSecretKey 同源的词根,并显式容忍连字符、下划线、空格,
 * 于是 `X-OC-Relay-Key: xxx` 与 `api key: xxx` 都能命中。
 * 分隔符含 `=>`(必须排在 `[:=]` 之前,否则只吃掉 `=` 而留下 `>` 与值)。
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
  // 先限长,再扫描 —— 见 MAX_SCAN_LENGTH 的说明。
  const scanned = input.length > MAX_SCAN_LENGTH ? input.slice(0, MAX_SCAN_LENGTH) : input;

  const out = stripControlChars(
    scanned
      // URL 内嵌凭证放在最前:后面的规则会把它切碎而漏掉。
      // scheme 的重复次数有上界,否则长小写串会触发二次回溯。
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

/** 供 redactValue 使用:把容器类对象转成可递归的普通结构。 */
function unwrapContainer(value: object): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return redactUrl(value.href);
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof RegExp) return value.source;
  return null;
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
    // Map/Set/URL/Date 走 Object.entries 会得到 {},诊断信息全丢。
    const unwrapped = unwrapContainer(value);
    if (unwrapped !== null) return redactValue(unwrapped, depth + 1);

    const out: Record<string, unknown> = {};
    /*
     * Object.entries 会触发 getter,而 getter 可能抛出一个消息里带凭证的错误。
     *
     * **不回显那个消息**:它源自正在被脱敏的这个结构,内容完全不受控 ——
     * 一个裸凭证字符串没有 key=value 形态,redactText 认不出来,会原样穿透。
     * 这里只报「读不出来」这个事实。
     */
    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(value as Record<string, unknown>);
    } catch {
      return { "[读取属性失败]": true };
    }

    for (const [k, v] of entries) {
      if (isSecretKey(k)) {
        /*
         * 只有字符串可能是凭证。数值不脱敏,于是 inputTokens / cacheReadTokens
         * 这类含 "token" 的用量字段不会被这条规则毁掉。
         */
        if (typeof v === "number" || typeof v === "boolean") {
          out[k] = v;
          continue;
        }
        // 保留字段名与「有没有值」,丢掉值本身 ——
        // 「key 是空的」和「key 配错了」是两种不同的故障,诊断时需要能区分。
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
        // 同上:不回显 getter 抛出的消息。
        out[k] = "[读取失败]";
      }
    }
    return out;
  }

  return REDACTED;
}

/**
 * 跟随 `cause` 链的层数上限。
 *
 * 有上限而不是跟到底:`cause` 由第三方库设置,深度不受我们控制,
 * 而这个结果要进单行日志。3 层足够覆盖实际形态
 * (`TypeError: fetch failed` → undici 的 `Error` → Node 的 `ErrnoException`)。
 */
const MAX_CAUSE_DEPTH = 3;

/**
 * 整条 cause 链拼接后的字符上限。
 *
 * 单层已被 `redactText` 限到 500,但四层拼起来会把单行日志的上界抬到 2000。
 */
const MAX_CAUSE_CHAIN_LENGTH = 800;

/**
 * 供错误处理直接使用：任何异常 → 一行安全文本。
 *
 * ## 为什么要跟 `cause`
 *
 * undici 的 fetch 把一切底层故障包成 `TypeError: fetch failed`,**真正的原因
 * 只在 `err.cause` 里**。先前这里只取 `err.message`,于是一个证书链故障
 * (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,上游证书链未被当前服务进程信任)
 * 在日志里只留下 `目录拉取失败(keyed): fetch failed` —— 三个词,不可诊断,
 * 而症状是 `/v1/models` 返回 HTTP 200 加一个空列表(空集合不报错)。
 * 脱敏函数无意中成了信息销毁函数。
 *
 * 每一层都各自过 `redactText`,所以跟随 cause **不会**放宽脱敏 ——
 * 底层错误同样可能带 URL 内嵌凭证。
 */
export function safeErrorMessage(err: unknown): string {
  const parts: string[] = [];
  // 环保护:`cause` 由外部设置,自引用与互引用都可能出现,跟到底会挂住。
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
      // 非 Error 的 cause(库偶尔塞对象/数字)。只在它是**首个**元素时
      // 才值得报「未知错误」—— 作为下层原因时,一个无消息的对象不提供信息。
      if (depth === 0) return "未知错误";
      break;
    }

    // 空消息不占位:`new Error()` 的 message 是 ""。
    // 但首层为空且没有下层时仍要回一句话,见循环结束后的兜底。
    if (text !== "") parts.push(text);

    if (!(current instanceof Error)) break;
    const next: unknown = (current as Error & { cause?: unknown }).cause;
    if (next === undefined) break;
    current = next;
  }

  if (parts.length === 0) return "未知错误";
  /*
   * 用 ← 表达因果方向:左边是表象,右边是原因。
   *
   * 总长再收一次:每层各自已被 `redactText` 限到 500,但四层拼起来会把
   * 单行日志的上界从 500 抬到 2000。诊断需要的是最外层加最内层那几个词,
   * 不是四段完整文本。(CR/LF 已由各层的 `stripControlChars` 去掉,
   * 所以拼接不会引入换行 —— 日志注入那条纪律在这里仍然成立。)
   */
  const joined = parts.join(" ← ");
  return joined.length > MAX_CAUSE_CHAIN_LENGTH
    ? `${joined.slice(0, MAX_CAUSE_CHAIN_LENGTH)}…`
    : joined;
}
