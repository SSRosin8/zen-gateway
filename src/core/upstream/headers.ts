import { randomUUID } from "node:crypto";
import { isSecretKey } from "../../shared/redact.ts";

/**
 * 上游请求头的构造与校验。定位是原样透传:只剥掉不能转发的、补上缺失的、拦住非法的。
 *
 * 用黑名单 + 通用凭证名规则而非白名单:OpenCode 新加的头若被静默丢掉,故障极难归因。
 * 必须剥掉四类:凭证(客户端 `Authorization` 是本网关的 Relay Token)、逐跳头、
 * 须由发起方重算的(`content-encoding` 是 `pipe.ts` 响应侧同一问题的请求侧镜像)、
 * 客户端自称的来源(会泄露内网拓扑)。
 * CR/LF 在进 undici 前自行校验:否则变成 500,且异常消息可能带出凭证头值。
 */

/** 不得从客户端转发给上游的头(全部小写比较)。 */
const STRIPPED_HEADERS = new Set([
  // ── 凭证(另有 isCredentialHeader 通用兜底,这里显式列出以表明意图) ──
  "authorization",
  "x-api-key",
  // `isSecretKey()` 认不出 `authentication`;在此局部补上,不改 redact.ts 共享名单。
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
  // 转发的是未压缩原始字节,留着它上游会对明文 gunzip。
  "content-encoding",
  // 由 fetch 自己按 dispatcher 与解码能力决定。
  "accept-encoding",
  // ── 客户端自称的来源:我们不是反代,转发它只泄露内网拓扑 ──
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  // 已持有完整请求体,不需要 100-continue 握手。
  "expect",
]);

/**
 * 头名是否像凭证(复用 `redact.ts` 的 `isSecretKey`,纪律 #4)。
 * 只豁免 `OPENCODE_IDENTITY_HEADERS` 显式名单(`x-opencode-session` 是 chat 面亲和依据);
 * 豁免整个 `x-opencode-` 前缀会放行 `x-opencode-api-key`。剥漏凭证看不见,宁可偏严。
 */
function isCredentialHeader(name: string): boolean {
  if ((OPENCODE_IDENTITY_HEADERS as readonly string[]).includes(name)) return false;
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
  /** 出问题的头名,供错误映射使用。不含头值:值可能是凭证。 */
  readonly headerName: string;

  constructor(headerName: string, message: string) {
    super(message);
    this.headerName = headerName;
  }
}

/**
 * 头值是否安全可转发:拒绝 C0 控制字符与 DEL(CR/LF 是注入原语,其余是解析歧义来源)。
 * 用逐码点循环而非正则:正则里的字面控制字符易被编辑器改写。
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
 * 构造上游请求头。顺序不可调换:透传客户端头 → 协议面头 → 网关掌握的头(鉴权、
 * content-type、Accept)。网关头最后写,客户端才无法改写鉴权与协议版本。
 */
export function buildUpstreamHeaders(input: BuildUpstreamHeadersInput): Record<string, string> {
  const out: Record<string, string> = {};
  const newId = input.newId ?? randomUUID;

  // 1. 透传。
  for (const [rawName, value] of Object.entries(input.clientHeaders)) {
    const name = rawName.toLowerCase();
    if (STRIPPED_HEADERS.has(name)) continue;
    // 通用凭证名兜底,挡住显式名单没想到的(`api-key`、`x-goog-api-key`、`x-auth-token`…)。
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
   * 2. 补齐身份头。`x-opencode-session` 是 chat 面会话亲和的唯一依据,缺失必须合成,
   * 否则每次可能换 Worker。`project`/`client` 是客户端自我描述,不代为编造。
   */
  if (out["x-opencode-session"] === undefined) out["x-opencode-session"] = newId();
  if (out["x-opencode-request"] === undefined) out["x-opencode-request"] = newId();

  /*
   * apiKey 的校验提前到协议面头之前,赋值仍在第 4 步:Messages 面把 key 镜像进 `extra`,
   * 否则会先命中笼统的「协议面头值非法」。含 CR/LF 的 key 若进 undici 会被归为 transport
   * 并报 502,而请求根本没发出;`SecretSchema` 已挡住,这里是纵深防御,给出正确的 400。
   */
  if (input.apiKey.trim() !== "" && !isSafeHeaderValue(input.apiKey)) {
    throw new HeaderValidationError(
      "authorization",
      "Worker 的 apiKey 含控制字符或换行,请检查配置中该 Worker 的 apiKey",
    );
  }

  // 3. 协议面特有头。
  for (const [name, value] of Object.entries(input.extra ?? {})) {
    const lower = name.toLowerCase();
    if (!isSafeHeaderName(lower)) throw new HeaderValidationError(lower, "协议面头名非法");
    if (!isSafeHeaderValue(value)) throw new HeaderValidationError(lower, "协议面头值非法");
    out[lower] = value;
  }

  // 4. 网关掌握的头 —— 放最后,不可被上面任何一步覆盖。
  if (input.apiKey.trim() !== "") out["authorization"] = `Bearer ${input.apiKey}`;
  out["content-type"] = "application/json";
  out["accept"] = input.streaming ? "text/event-stream" : "application/json";

  return out;
}

