import type { FailureKind } from "../../core/failures.ts";
import { safeErrorMessage } from "../../shared/redact.ts";
import { HeaderValidationError } from "../../core/upstream/headers.ts";

/**
 * 错误映射 —— 网关自己生成的错误响应。
 *
 * ## 边界:这里只处理「没能拿到上游响应」的情况
 *
 * 拿到了上游响应就原样透传(含错误响应)—— 客户端应当看到上游真实的
 * 429 负载、400 字段报错,而不是网关的转述。本文件负责的是另一半:
 * 请求还没出去就被拒(免费判定、缺模型、鉴权),或出去了但连响应头都没拿到
 * (连接失败、超时)。
 *
 * ## 错误体形状对齐 OpenAI
 *
 * `{ "error": { "type": ..., "message": ... } }`。OpenCode 与各类客户端
 * 都按这个形状解析,自造形状会让客户端显示「未知错误」而不是我们写的说明 ——
 * 那等于把一条可自查的信息扔掉。
 *
 * ## 绝不回显的东西
 *
 * 上游原始错误文本可能含订阅 URL 的 token、代理口令、API key 片段。
 * 所有进 message 的文本都要过 `safeErrorMessage`。
 */

/** 网关自己的拒绝类型。与上游的错误类型区分开,便于用户定位是谁拒的。 */
export type GatewayErrorType =
  /** 模型不在免费集里。 */
  | "model_not_allowed"
  /** 请求体缺 model 字段或形状不对。 */
  | "invalid_request"
  /** 请求头非法(CR/LF 注入等)。 */
  | "invalid_header"
  /** 没有可用 Worker。 */
  | "no_worker_available"
  /** 出口配置错误。 */
  | "egress_unavailable"
  /** 上游连接失败/超时。 */
  | "upstream_unreachable"
  /** 网关内部错误。 */
  | "internal_error";

export type GatewayErrorBody = {
  readonly error: {
    readonly type: GatewayErrorType;
    readonly message: string;
  };
};

export function gatewayError(type: GatewayErrorType, message: string): GatewayErrorBody {
  return { error: { type, message } };
}

/** HTTP 状态码。刻意不用 4xx/5xx 兜底 —— 每个类型显式给码。 */
export function statusForGatewayError(type: GatewayErrorType): number {
  switch (type) {
    case "model_not_allowed":
      // 403 而非 400:请求本身合法,是策略不允许。
      return 403;
    case "invalid_request":
    case "invalid_header":
      return 400;
    case "no_worker_available":
      // 503:这是暂时性的(配上 Worker 就好),客户端重试有意义。
      return 503;
    case "egress_unavailable":
      // 503 同理,但原因在本地配置。
      return 503;
    case "upstream_unreachable":
      // 502:我们是网关,上游不可达。
      return 502;
    case "internal_error":
      return 500;
  }
}

/**
 * 把重试链的失败分类映射为网关错误类型。
 *
 * 仅在**没拿到上游响应**时用。拿到了就透传,不走这里。
 */
export function typeForFailureKind(kind: FailureKind): GatewayErrorType {
  switch (kind) {
    case "transport":
    case "upstream_error":
      return "upstream_unreachable";
    case "timeout":
      return "upstream_unreachable";
    case "auth":
    case "forbidden":
    case "rate_limit":
      /*
       * 走到这里意味着「分类为 auth/rate_limit 但没有上游响应」——
       * 正常路径下这两类必定带响应(401/429 都是响应),所以这是异常情况,
       * 报 upstream_unreachable 比谎称鉴权失败更准确。
       */
      return "upstream_unreachable";
    case "bad_request":
      return "invalid_request";
    case "unknown":
      return "internal_error";
  }
}

/**
 * 把一个抛出的异常变成错误体。
 *
 * `HeaderValidationError` 单独处理:它是**客户端**的错(400),
 * 而且它的 message 已经刻意不含头值,可以直接用。
 */
export function errorBodyFromException(err: unknown): {
  status: number;
  body: GatewayErrorBody;
} {
  if (err instanceof HeaderValidationError) {
    return {
      status: 400,
      body: gatewayError("invalid_header", err.message),
    };
  }

  /*
   * 其余异常一律 500 且**不回显原始消息的细节**。
   *
   * safeErrorMessage 会脱敏,但即便如此,一个内部异常的文本
   * (栈、文件路径、库内部状态)对客户端没有价值,对攻击者有。
   * 真实消息进日志,客户端只得到一句中性说明。
   */
  return {
    status: 500,
    body: gatewayError("internal_error", "网关内部错误,详见服务端日志"),
  };
}

/** 供日志使用的脱敏文本。与返回给客户端的 message 是两条不同的信息。 */
export function logMessageFor(err: unknown): string {
  return safeErrorMessage(err);
}
