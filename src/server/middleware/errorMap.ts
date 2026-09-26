import type { FailureKind } from "../../core/failures.ts";
import { HeaderValidationError } from "../../core/upstream/headers.ts";

/**
 * 网关自己生成的错误响应，只用于没拿到上游响应的情况；拿到了就原样透传。
 * 错误体形状对齐 OpenAI（`{ error: { type, message } }`），客户端才能显示我们的说明。
 * 进 message 的文本都要过 `safeErrorMessage`。
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

/** 把重试链的失败分类映射为网关错误类型；仅在没拿到上游响应时用。 */
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
      // 这几类正常必带响应；没响应时报 upstream_unreachable 比谎称鉴权失败更准确。
      return "upstream_unreachable";
    case "bad_request":
      return "invalid_request";
    case "unknown":
      return "internal_error";
  }
}

/**
 * 把抛出的异常变成错误体。`HeaderValidationError` 是客户端的错（400），其 message 已不含头值。
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

  // 其余异常一律 500，不回显内部细节；真实消息进日志。
  return {
    status: 500,
    body: gatewayError("internal_error", "网关内部错误,详见服务端日志"),
  };
}

