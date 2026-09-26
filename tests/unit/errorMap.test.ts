import { describe, expect, it } from "vitest";
import {
  errorBodyFromException,
  gatewayError,
  statusForGatewayError,
  typeForFailureKind,
} from "../../src/server/middleware/errorMap.ts";
import { HeaderValidationError } from "../../src/core/upstream/headers.ts";

/**
 * 错误映射:内部异常不回显、失败分类到对外错误类型与状态码的映射。
 */

describe("错误映射", () => {
  it("内部异常不回显原始消息", () => {
    /*
     * `safeErrorMessage` 只脱敏 key=value 形态。内部异常的栈、文件路径、
     * 库内部状态不是凭证形,`redactText` 认不出,会原样穿透给客户端。
     * 先前把 500 分支改成回显 `safeErrorMessage(err)` 后全套仍绿。
     */
    const err = new Error("ENOENT: /home/someone/.config/zen-gateway/data/config.json 第 42 行");
    const { status, body } = errorBodyFromException(err);
    expect(status).toBe(500);
    expect(body.error.message).not.toContain("/home/someone");
    expect(body.error.message).not.toContain("config.json");
  });

  it("HeaderValidationError 映射为 400 而非 500", () => {
    // 这类请求是客户端的错。归到 500 会让用户以为是网关坏了。
    const { status, body } = errorBodyFromException(
      new HeaderValidationError("x-custom", "请求头 x-custom 的值含控制字符或换行"),
    );
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_header");
    // 该错误的 message 刻意不含头值,可以直接用。
    expect(body.error.message).toContain("x-custom");
  });

  it("HeaderValidationError 的消息不含头值", () => {
    const err = new HeaderValidationError("x-custom", "请求头 x-custom 的值含控制字符或换行");
    expect(errorBodyFromException(err).body.error.message).not.toContain("SECRET");
  });

  it.each([
    ["model_not_allowed", 403],
    ["invalid_request", 400],
    ["invalid_header", 400],
    ["no_worker_available", 503],
    ["egress_unavailable", 503],
    ["upstream_unreachable", 502],
    ["internal_error", 500],
  ] as const)("状态码映射：%s → %i", (type, expected) => {
    expect(statusForGatewayError(type)).toBe(expected);
  });

  it.each([
    ["transport", "upstream_unreachable"],
    ["upstream_error", "upstream_unreachable"],
    ["timeout", "upstream_unreachable"],
    ["bad_request", "invalid_request"],
    ["unknown", "internal_error"],
  ] as const)("失败分类映射：%s → %s", (kind, expected) => {
    expect(typeForFailureKind(kind)).toBe(expected);
  });

  it("auth/rate_limit 在无上游响应时报 upstream_unreachable", () => {
    /*
     * 正常路径下这两类必定带响应（401/429 都是响应）,走到这里说明是异常情况。
     * 谎称"鉴权失败"会让用户去查 key,而真实原因是连接层问题。
     */
    expect(typeForFailureKind("auth")).toBe("upstream_unreachable");
    expect(typeForFailureKind("rate_limit")).toBe("upstream_unreachable");
  });

  it("错误体形状对齐 OpenAI，客户端才能显示我们写的说明", () => {
    const body = gatewayError("model_not_allowed", "某模型不在免费集内");
    expect(body).toEqual({ error: { type: "model_not_allowed", message: "某模型不在免费集内" } });
  });
});
