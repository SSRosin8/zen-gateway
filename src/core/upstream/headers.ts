import { randomUUID } from "node:crypto";
import { isSecretKey } from "../../shared/redact.ts";

/**
 * 上游请求头的构造与校验。
 *
 * 本项目定位是**原样透传**:客户端(OpenCode)发来的身份头要尽量原样带给上游,
 * 网关只做三件事 —— 剥掉不能转发的、补上缺失的、拦住非法的。
 *
 * ## 为什么用黑名单而不是白名单
 *
 * 白名单（只放行 `x-opencode-*` 加几个）更保险,但会破坏"原样透传":
 * OpenCode 在高频迭代,它明天新加的头会被我们静默丢掉,而那种故障
 * 表现为"某个新功能在网关后面不工作",极难归因。所以用黑名单 +
 * 一条**通用凭证名规则**兜底,而不是逐个枚举头名玩打地鼠。
 *
 * ## 四类必须剥掉的头
 *
 * 1. **凭证类**。客户端侧的 `Authorization` 带的是**本网关的 Relay Token**,
 *    与上游凭证完全无关;原样转发等于把本机网关口令泄露给上游,而且会覆盖
 *    掉我们要设的 Worker key。同类还有 `x-api-key`、`api-key`、`cookie` 等。
 *    这一类用 `isSecretKey()` 通用识别 —— 见下面 `isCredentialHeader`。
 * 2. **逐跳头**(`connection`/`keep-alive`/`transfer-encoding`/`upgrade`/
 *    `proxy-*`/`te`/`trailer`)—— 按 HTTP 语义它们只对单跳有效,
 *    转发会让 undici 与上游对连接状态产生分歧。
 * 3. **必须由发起方重算的**(`host`/`content-length`/`content-encoding`)。
 *    `content-encoding` 尤其要紧:我们转发的是**原始未压缩字节**,
 *    残留一个 `gzip` 会让上游去 gunzip 明文。这是 `pipe.ts` 在响应侧
 *    已修掉的同一个 bug 的**请求侧镜像** —— 先前只剥了响应侧。
 * 4. **客户端自称的来源信息**(`x-forwarded-for`/`x-real-ip`/`forwarded`)。
 *    我们不是反向代理链的一环,转发它等于把内网拓扑(如 `10.1.2.3`)
 *    泄露给上游,并代为断言一件我们从未验证过的事。
 *
 * ## 为什么要自己校验 CR/LF 而不依赖 undici
 *
 * undici 遇到非法头值会抛异常,那会变成一个 500 —— 但这类请求是**客户端**
 * 的错,应当是 400 并说明哪个头非法。更要紧的是:异常消息可能带上头值本身,
 * 而头值可能是凭证。所以在进 undici 之前就校验并自己措辞。
 */

/** 不得从客户端转发给上游的头(全部小写比较)。 */
const STRIPPED_HEADERS = new Set([
  // ── 凭证(另有 isCredentialHeader 通用兜底,这里显式列出以表明意图) ──
  "authorization",
  "x-api-key",
  /*
   * `authentication` 是 `isSecretKey()` 唯一认不出的凭证头名
   * (它的子串表里只有 `authorization`)。不去改 redact.ts 的共享名单 ——
   * 那会牵动脱敏行为与它自己的测试;在这里显式补上更局部。
   */
  "authentication",
  // ── 逐跳头 ──
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  // ── 必须由发起方重算 ──
  "host",
  "content-length",
  /*
   * 我们转发原始未压缩字节,所以客户端声明的 content-encoding 必定不成立。
   * 留着它 → 上游对明文做 gunzip → 解码失败。响应侧的同一个 bug 在
   * pipe.ts 里已修,请求侧先前漏了。
   */
  "content-encoding",
  // 由 fetch 自己按 dispatcher 与解码能力决定。
  "accept-encoding",
  // ── 客户端自称的来源:我们不是反代,转发它只泄露内网拓扑 ──
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  /*
   * `expect: 100-continue` 需要发起方与上游协商,我们已经持有完整请求体,
   * 转发它会让 undici 与上游多一轮不必要的握手。
   */
  "expect",
]);

/**
 * OpenCode 自己的命名空间 —— 豁免通用凭证规则。
 *
 * 两个理由:这些是我们**必须**原样透传的身份头(`x-opencode-session` 更是
 * chat 面唯一的亲和依据);而且它们发往 OpenCode 自己的上游,即便其中真带了
 * 什么凭证,那也是发回给凭证的主人。
 *
 * 没有这条豁免,将来 OpenCode 加一个名字里含 `key`/`token` 的头
 * (如 `x-opencode-token-budget`)会被通用规则静默剥掉,表现为"某个新功能
 * 在网关后面不工作"。
 */
const PASSTHROUGH_PREFIX = "x-opencode-";

/**
 * 这个头名看起来像凭证吗?
 *
 * 复用 `redact.ts` 的 `isSecretKey` —— "哪些名字意味着密"这条知识已经
 * 集中在那里并配了测试,不该在本文件复制一份人工名单。实测它对 OpenCode
 * 实际会发的头(四个 `x-opencode-*`、`user-agent`、`anthropic-version`、
 * `x-stainless-*`、`openai-beta` 等)**零误判**。
 *
 * 取向说明:过度剥离的后果是"某个功能不工作",看得见;剥漏的后果是
 * "凭证静默外泄",看不见。两侧不对称,所以宁可偏严。
 */
function isCredentialHeader(name: string): boolean {
  if (name.startsWith(PASSTHROUGH_PREFIX)) return false;
  return isSecretKey(name);
}

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
    /*
     * 通用凭证名兜底。放在显式名单之后:名单表达"为什么这一条特殊",
     * 这条规则负责挡住我们没想到的那些(`api-key`、`x-goog-api-key`、
     * `x-oc-relay-key`、`x-auth-token`…)。逐个枚举头名是打地鼠。
     */
    if (isCredentialHeader(name)) continue;
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
  /*
   * `apiKey` 也要过校验,尽管它来自我们自己的配置。
   *
   * 归因问题:含 CR/LF 的 key 会让 undici 在 fetch 时抛错,而那个失败被
   * `classifyError` 归为 `transport` → 客户端收到「502 上游不可达」,
   * **尽管请求根本没发出去**。用户会去查网络和上游状态,而真实原因是
   * 配置里那个 key 粘贴时带进了换行。
   *
   * `SecretSchema` 已在加载配置时挡住这种值,这里是纵深防御 ——
   * 成本是一次字符串扫描,而收益是错误类型从 502 变成正确的 400,
   * 且消息直接指出是 apiKey 的问题。
   */
  if (!isSafeHeaderValue(input.apiKey)) {
    throw new HeaderValidationError(
      "authorization",
      "Worker 的 apiKey 含控制字符或换行,请检查配置中该 Worker 的 apiKey",
    );
  }
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
