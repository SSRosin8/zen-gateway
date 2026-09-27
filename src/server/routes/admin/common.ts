import type { Context } from "hono";
import type { z } from "zod";
import { AdminErrorSchema, type AdminErrorType } from "../../../shared/contract.ts";
import { BodyTooLargeError, readBoundedBody } from "../../boundedBody.ts";

/** 管理请求体上限。与 relay 的 64 MiB 刻意不同：多模态只在转发面。 */
export const MAX_ADMIN_BODY_BYTES = 1024 * 1024;

const STATUS: Record<AdminErrorType, 400 | 401 | 404 | 409 | 422 | 500> = {
  invalid_request: 400,
  invalid_config: 422,
  write_failed: 500,
  not_found: 404,
  conflict: 409,
  auth_required: 401,
  lan_login_required: 401,
  internal_error: 500,
};

export function adminError(c: Context, type: AdminErrorType, message: string) {
  // 经 `AdminErrorSchema` 构造，避免 schema 与手写形状各存一份。
  return c.json(AdminErrorSchema.parse({ error: { type, message } }), STATUS[type]);
}

/** zod issue 只给路径与规则，不回显值（值里可能有凭证）。 */
export function issuesText(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join(".") || "(根)"}: ${i.message}`)
    .join("; ");
}

/**
 * 有界读体 → JSON → strict schema。失败时返回已构造好的错误响应。
 * 空体按 `{}` 处理：只有可选字段的端点允许不带体。
 */
export async function readJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: Uint8Array;
  try {
    raw = await readBoundedBody(c.req.raw, MAX_ADMIN_BODY_BYTES);
  } catch (err) {
    const message = err instanceof BodyTooLargeError ? "请求体超过上限(1 MiB)" : "无法读取请求体";
    return { ok: false, response: adminError(c, "invalid_request", message) };
  }
  let parsed: unknown = {};
  if (raw.byteLength > 0) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return { ok: false, response: adminError(c, "invalid_request", "请求体不是合法 JSON") };
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, response: adminError(c, "invalid_request", issuesText(result.error.issues)) };
  }
  return { ok: true, data: result.data };
}
