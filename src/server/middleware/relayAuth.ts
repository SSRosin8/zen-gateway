import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Relay Token 鉴权。
 *
 * ## 为什么要定长比较
 *
 * `a === b` 对字符串是短路比较:第一个不同的字节就返回。攻击者据此可以
 * 按字节逐位试探,把 256^n 的暴力破解降到 256*n 次。这个网关只监听回环,
 * 所以威胁模型不是远端攻击者,而是**本机上的其他进程**(浏览器里的恶意页面
 * 经 fetch 打本地端口、装错的 npm 包、多用户机器上的别人)。对这些来说
 * 时间侧信道完全可用。
 *
 * `timingSafeEqual` 要求两侧**长度相同**,长度不同直接抛。所以必须先比长度 ——
 * 而长度本身就泄露(无法避免),这也是 schema 要求 token 至少 16 字符的原因:
 * 知道长度对猜出内容没有实质帮助。
 *
 * ## 为什么没有「空 token 等于不校验」
 *
 * 一个默认空 token 意味着本机任何进程都能白用网关,而那会是**默认行为**
 * 而非用户的选择。schema 用 `.min(16)` 让这种形态无法表达,首启自动生成。
 */

/** 预先把期望值编码成 Buffer,避免每请求重复编码。 */
function encode(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

/**
 * 定长比较两个字符串。
 *
 * 长度不同时**仍然**做一次等长的假比较,让「长度错」与「内容错」耗时一致。
 * 严格说长度差异仍可由响应时间外的信道观察到,但这里不额外贡献信号。
 */
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
 * 从请求里取出客户端提供的 token。
 *
 * 只认 `Authorization: Bearer <token>`。不支持 query 参数形式 ——
 * URL 会进浏览器历史、代理日志、`Referer` 头,凭证放在那里必然泄露。
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
};

/**
 * 中间件:校验 Relay Token。
 *
 * 失败一律返回 401 且**措辞一致** —— 不区分「没带」「格式不对」「值不对」。
 * 区分开会告诉探测者他走到了哪一步,而对合法用户这三种情况的处置是同一个:
 * 检查配置里的 relayToken。
 */
export function relayAuth(options: RelayAuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const provided = extractBearer(c.req.header("authorization"));
    const expected = options.tokenOf();

    /*
     * 期望值为空串时**一律拒绝**,这是第二道防护。
     *
     * 不加这一条会 fail-open:`secureCompare("", "")` 比较两个零长 Buffer,
     * `timingSafeEqual` 返回 true —— 于是一个**不带** Authorization 的请求
     * 被放行,而带了任意 token 的反而 401。实测过这个行为。
     *
     * 本文件开头声称"没有『空 token 等于不校验』这种形态",但先前那条保证
     * 完全依赖 schema 的 `.min(16)`,中间件自身既无防御也无测试。
     * `models/free.ts` 为同样的理由刻意留了第二道(`freeSuffix` 空串检查),
     * 理由是"一个『配置写错就全开』的闸门不该只有一层防护" —— 这里本该一致。
     *
     * 而且这不只是理论:`tokenOf()` 是为配置热更新做成的函数(Phase 9),
     * 届时任何绕过 schema 的写入路径都会直接把这道门打开。
     *
     * 放在比较之前返回不引入时间信道:它只依赖**配置**(本机的、非机密的
     * 部署状态),不依赖请求里的任何内容,所以对攻击者没有可利用的差异。
     */
    if (expected === "") {
      return unauthorized(c);
    }

    /*
     * 即使没带 token 也走一次比较。
     *
     * 直接 `if (provided === null) return 401` 会让「没带」明显快于「带错」,
     * 那本身就是一个可测量的信号。用空串走同一条路径。
     */
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
        message: "缺少或无效的 Relay Token,请在 Authorization 头以 Bearer 方式提供",
      },
    },
    401,
  );
}
