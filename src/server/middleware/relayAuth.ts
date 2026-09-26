import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Relay Token 鉴权。威胁模型是本机其他进程（恶意网页经 fetch 打本地端口、装错的 npm 包），
 * 所以用定长比较防时间侧信道；长度泄露无法避免，schema 因此要求 token 至少 16 字符。
 * 没有「空 token 等于不校验」的形态：schema `.min(16)`，首启自动生成。
 */

/** 预先把期望值编码成 Buffer,避免每请求重复编码。 */
function encode(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

/** 定长比较。长度不同时仍做一次等长假比较，让「长度错」与「内容错」耗时一致。 */
export function secureCompare(actual: string, expected: string): boolean {
  const a = encode(actual);
  const b = encode(expected);

  if (a.length !== b.length) {
    // 与 b 自身比一次,保持耗时量级一致;结果丢弃。
    timingSafeEqual(b, b);
    return false;
  }

  return timingSafeEqual(a, b);
}

/**
 * 解析 `Authorization: Bearer <token>`；`x-api-key` 由 `providedToken` 按面决定。
 * 不支持 query 参数形式：URL 会进历史、日志与 `Referer`。
 */
export function extractBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  // scheme 大小写不敏感(RFC 7235),但必须恰好一个空格分隔。
  const match = /^Bearer (.+)$/i.exec(header);
  if (match === null) return null;
  const token = match[1]!;
  return token === "" ? null : token;
}

export type RelayAuthOptions = {
  /** 读取当前有效 token。做成函数以便配置热更新后立即生效。 */
  readonly tokenOf: () => string;
  /** 是否也接受 `x-api-key`；由挂载方按面的 `acceptsApiKeyHeader` 推导。 */
  readonly acceptApiKeyHeader?: boolean;
};

/** Bearer 优先，允许时再看 `x-api-key`；两个都带只认 Bearer，不让一次请求试两个候选值。 */
function providedToken(
  c: Parameters<MiddlewareHandler>[0],
  acceptApiKeyHeader: boolean,
): string | null {
  const bearer = extractBearer(c.req.header("authorization"));
  if (bearer !== null || !acceptApiKeyHeader) return bearer;
  const apiKey = c.req.header("x-api-key");
  return apiKey === undefined || apiKey === "" ? null : apiKey;
}

/** 校验 Relay Token。失败一律同一措辞的 401，不告诉探测者走到了哪一步。 */
export function relayAuth(options: RelayAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const provided = providedToken(c, options.acceptApiKeyHeader === true);
    const expected = options.tokenOf();

    /*
     * 期望值为空串时一律拒绝（第二道防护，同 `models/free.ts` 的 `freeSuffix` 检查）：
     * 否则 `secureCompare("", "")` 为真，不带 token 的请求会被放行。
     * 只依赖配置，不引入时间信道。
     */
    if (expected === "") {
      return unauthorized(c);
    }

    // 没带 token 也走一次比较，避免「没带」明显快于「带错」。
    const ok = secureCompare(provided ?? "", expected);

    if (!ok) {
      return unauthorized(c);
    }

    return next();
  };
}

/** 统一的 401 —— 措辞必须只有一处,否则迟早出现可区分的分支。 */
function unauthorized(c: Parameters<MiddlewareHandler>[0]): Response {
  return c.json(
    {
      error: {
        type: "unauthorized",
        message: "缺少或无效的 Relay Token,请在 Authorization 头以 Bearer 方式提供(Messages 面也可用 x-api-key)",
      },
    },
    401,
  );
}
