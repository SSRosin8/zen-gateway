import { useCallback, useState } from "react";
import {
  ClashDiscoverResponseSchema,
  ClashImportResponseSchema,
  OpenCodeViewSchema,
  ProbeReportSchema,
  type OpenCodeView,
  type ProbeReport,
} from "../../shared/contract.ts";

/**
 * 控制台新增端点的客户端：Clash 探测与导入、诊断、OpenCode 项目配置。
 *
 * 与 `api.ts` 同一条规则：每个响应过 schema，契约不匹配与网关没在跑分开报。
 * 错误带 HTTP 状态码，调用方据此区分 409（批量探测占用 Clash）等可解释的冲突。
 */

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Parser<T> = { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } } };

async function request<T>(method: string, path: string, schema: Parser<T>, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "未连接到网关服务（运行 npm start）");
  }
  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (raw as { error?: { message?: unknown } } | null)?.error?.message;
    throw new ApiError(res.status, typeof message === "string" ? message : `HTTP ${res.status}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : `${issue.path.join(".")}：${issue.message}`;
    throw new ApiError(res.status, `响应与契约不匹配（前后端版本可能不一致，试 npm run build）${where === "" ? "" : ` ${where}`}`);
  }
  return parsed.data;
}

/* 响应 schema 全部来自 `shared/contract.ts`：服务端用同一份构造响应（纪律 #4）。 */


export function discoverClash(body: { apiBase?: string; secret?: string }) {
  return request("POST", "/api/clash/discover", ClashDiscoverResponseSchema, body);
}

export function importClash(body: { apiBase: string; secret?: string; dryRun: boolean }) {
  return request("POST", "/api/clash/import", ClashImportResponseSchema, body);
}

/** 探测指定出口并写回 IP；批量探测进行中时服务端回 409。 */
export function probeEgress(proxyIds: readonly string[]): Promise<ProbeReport> {
  return request("POST", "/api/probe", ProbeReportSchema, { proxyIds });
}

/** 深度出口测试：与 `/api/probe` 同形；批量探测进行中时服务端回 409。 */
export function runDeepEgressTest(): Promise<ProbeReport> {
  return request("POST", "/api/diagnostics/deep", ProbeReportSchema);
}

export function writeOpenCodeConfig(version?: "1" | "2"): Promise<OpenCodeView> {
  return request("POST", "/api/opencode/write", OpenCodeViewSchema, version === undefined ? {} : { version });
}

export { versionFor as versionFromDetected } from "../../shared/openCodeConfig.ts";

/** 一次性动作（按钮 → 请求 → 结果）的通用状态。 */
export type ActionState<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; data: T }
  | { status: "error"; message: string; httpStatus: number };

export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [state, setState] = useState<ActionState<T>>({ status: "idle" });
  const run = useCallback(
    async (...args: A): Promise<T | null> => {
      setState({ status: "running" });
      try {
        const data = await fn(...args);
        setState({ status: "done", data });
        return data;
      } catch (err) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
          httpStatus: err instanceof ApiError ? err.status : 0,
        });
        return null;
      }
    },
    // fn 是模块级函数，不随渲染变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}
