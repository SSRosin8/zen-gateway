import { randomUUID } from "node:crypto";

/**
 * 上游请求头的构造与校验。
 *
 * 本项目定位是**原样透传**:客户端(OpenCode)发来的身份头要尽量原样带给上游,
 * 网关只做三件事 —— 剥掉不能转发的、补上缺失的、拦住非法的。
 *
 * ## 三类必须剥掉的头
 *
 * 1. **`Authorization`** —— 客户端这一侧带的是**本网关的 Relay Token**,
 *    与上游凭证完全无关。原样转发等于把本机网关口令泄露给上游,
 *    而且会覆盖掉我们要设的 Worker key。这是本文件最重要的一条。
 * 2. **逐跳头**(`connection`/`keep-alive`/`transfer-encoding`/`upgrade`/
 *    `proxy-*`/`te`/`trailer`)—— 按 HTTP 语义它们只对单跳有效,
 *    转发会让 undici 与上游对连接状态产生分歧。
 * 3. **`host`/`content-length`** —— 必须由发起方按实际目标与实际字节数重算,
 *    转发旧值会得到一个指向本机的 Host 或一个错的长度。
 *
 * ## 为什么要自己校验 CR/LF 而不依赖 undici
 *
 * undici 遇到非法头值会抛异常,那会变成一个 500 —— 但这类请求是**客户端**
 * 的错,应当是 400 并说明哪个头非法。更要紧的是:异常消息可能带上头值本身,
 * 而头值可能是凭证。所以在进 undici 之前就校验并自己措辞。
 */

/** 不得从客户端转发给上游的头(全部小写比较)。 */
const STRIPPED_HEADERS = new Set([
  // 客户端侧的 Authorization 是 Relay Token,不是上游凭证 —— 绝不转发。
  "authorization",
  // 同理:Anthropic 风格的 key 头也可能被客户端带上。
  "x-api-key",
  // 逐跳头。
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  // 必须由发起方重算。
  "host",
  "content-length",
  // 由 fetch 自己按 dispatcher 与解码能力决定。
  "accept-encoding",
]);

/** OpenCode 的客户端身份头 —— 这些要原样透传,缺失时合成。 */
export const OPENCODE_IDENTITY_HEADERS = [
  "x-opencode-session",
  "x-opencode-request",
  "x-opencode-project",
  "x-opencode-client",
] as const;

export class HeaderValidationError extends Error {
  override readonly name = "HeaderValidationError";
  /** 出问题的头名,供错误映射使用。**不含头值** —— 值可能是凭证。 */
  readonly headerName: string;

  constructor(headerName: string, message: string) {
    super(message);
    this.headerName = headerName;
  }
}

/**
 * 头值是否安全可转发。
 *
 * 拒绝 CR、LF 以及所有 C0 控制字符与 DEL。CR/LF 是 header 注入的直接原语
 * (`a\r\nX-Injected: 1`);其余控制字符虽不能直接注入,但会被不同 HTTP 实现
 * 以不同方式处理,是典型的解析歧义来源。
 *
 * 用逐码点循环而非正则:这段要处理不可信输入,正则里的字面控制字符
 * 在源码层面就容易被编辑器/工具改写成别的东西(本项目在 redact.ts 已踩过)。
 */
export function isSafeHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** 头名是否合法(RFC 7230 token)。非法头名同样是注入原语。 */
export function isSafeHeaderName(name: string): boolean {
  if (name === "") return false;
  // token = 1*tchar,tchar 为 !#$%&'*+-.^_`|~ 与字母数字。
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

export type BuildUpstreamHeadersInput = {
  /** 客户端发来的头(名已小写)。 */
  readonly clientHeaders: Readonly<Record<string, string>>;
  /** 本次选中 Worker 的上游 key。 */
  readonly apiKey: string;
  /** 客户端是否要求流式。 */
  readonly streaming: boolean;
  /** 协议面特有的头。 */
  readonly extra?: Readonly<Record<string, string>>;
  /** 注入以便测试。 */
  readonly newId?: () => string;
};

/**
 * 构造上游请求头。
 *
 * 顺序刻意如下,且**不可调换**:
 *   1. 透传客户端头(已剥离 + 已校验)
 *   2. 叠加协议面特有头
 *   3. 最后写入网关自己掌握的头(鉴权、content-type、Accept)
 *
 * 第 3 步在最后,是为了让**网关的决定不可被客户端覆盖**。若顺序反过来,
 * 客户端发一个 `x-api-key` 或 `anthropic-version` 就能改写我们的鉴权与
 * 协议版本 —— 那是一个由客户端控制的降级原语。
 */
export function buildUpstreamHeaders(input: BuildUpstreamHeadersInput): Record<string, string> {
  const out: Record<string, string> = {};
  const newId = input.newId ?? randomUUID;

  // 1. 透传。
  for (const [rawName, value] of Object.entries(input.clientHeaders)) {
    const name = rawName.toLowerCase();
    if (STRIPPED_HEADERS.has(name)) continue;
    if (!isSafeHeaderName(name)) {
      throw new HeaderValidationError(name, "请求头名含非法字符");
    }
    if (!isSafeHeaderValue(value)) {
      // 绝不把 value 放进消息:它可能是凭证,而这条消息会进日志与响应。
      throw new HeaderValidationError(name, `请求头 ${name} 的值含控制字符或换行`);
    }
    out[name] = value;
  }

  /*
   * 2. 补齐 OpenCode 身份头。
   *
   * `x-opencode-session` 是**会话亲和在 chat 面上唯一的依据**(该面的请求体里
   * 没有会话标识),所以它不能缺:缺了会让每个请求被当成新会话,
   * 粘滞失效 → 每次可能换 Worker → 上游侧的推理连续性与缓存命中一起失去。
   * 因此缺失时必须合成一个,而不是留空。
   *
   * 同理补 `x-opencode-request`(每请求唯一,便于上游侧定位单次调用)。
   * `project`/`client` 不合成 —— 它们是客户端的自我描述,网关替它编造
   * 只会让上游侧的统计出现不存在的项目名。
   */
  if (out["x-opencode-session"] === undefined) out["x-opencode-session"] = newId();
  if (out["x-opencode-request"] === undefined) out["x-opencode-request"] = newId();

  // 3. 协议面特有头。
  for (const [name, value] of Object.entries(input.extra ?? {})) {
    const lower = name.toLowerCase();
    if (!isSafeHeaderName(lower)) throw new HeaderValidationError(lower, "协议面头名非法");
    if (!isSafeHeaderValue(value)) throw new HeaderValidationError(lower, "协议面头值非法");
    out[lower] = value;
  }

  // 4. 网关掌握的头 —— 放最后,不可被上面任何一步覆盖。
  out["authorization"] = `Bearer ${input.apiKey}`;
  out["content-type"] = "application/json";
  out["accept"] = input.streaming ? "text/event-stream" : "application/json";

  return out;
}

/**
 * 从 Headers 对象收集小写名的普通对象。
 *
 * Hono 的 `c.req.header()` 无参调用已返回小写名对象,但测试与其他调用方
 * 可能持有 `Headers`,所以提供这个转换。重复头由 Headers 自己合并为逗号分隔。
 */
export function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}
