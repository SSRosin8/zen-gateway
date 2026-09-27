import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { LanLoginRequestSchema, LanPasswordRequestSchema, LanStatusSchema } from "../../../shared/contract.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import { isLocalRequest } from "../../middleware/loopbackOnly.ts";
import { hashLanPassword, LAN_COOKIE, LAN_SESSION_MS, lanAddresses, type LanAccess } from "../../admin/lanAccess.ts";
import type { AdminDeps } from "../admin.ts";
import { adminError, readJsonBody } from "./common.ts";

/**
 * 局域网访问：状态、登录、登出、设置口令。登录与状态对局域网请求免会话
 * （`LAN_PUBLIC_PATHS`，由 `app.ts` 交给回环闸门）；设置口令只接受本机浏览器。
 */
export const LAN_PUBLIC_PATHS: ReadonlySet<string> = new Set(["/api/lan/status", "/api/lan/login"]);

export function sessionCookie(c: Context): string | undefined {
  return getCookie(c, LAN_COOKIE);
}

export function createLanRoutes(deps: AdminDeps & { lan: LanAccess }): Hono {
  const app = new Hono();
  const { lan } = deps;

  app.get("/lan/status", (c) => {
    const local = isLocalRequest(c);
    return c.json(
      LanStatusSchema.parse({
        enabled: lan.enabled(),
        local,
        authenticated: local || lan.valid(sessionCookie(c)),
        // 地址只告诉本机：局域网访客已经知道自己用哪个地址进来的。
        addresses: local && deps.adminPort !== undefined ? lanAddresses().map((ip) => `http://${ip}:${deps.adminPort}`) : [],
      }),
    );
  });

  app.post("/lan/login", async (c) => {
    const body = await readJsonBody(c, LanLoginRequestSchema);
    if (!body.ok) return body.response;
    const outcome = lan.login(body.data.password);
    switch (outcome.kind) {
      case "disabled":
        return adminError(c, "invalid_config", "局域网访问未开启,请在本机后台的网关页设置访问口令");
      case "bad_password":
        return adminError(c, "auth_required", "访问口令不对");
      case "locked":
        return adminError(c, "conflict", `尝试次数过多,请 ${Math.ceil(outcome.retryAfterMs / 1000)} 秒后再试`);
      case "ok":
        setCookie(c, LAN_COOKIE, outcome.token, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          maxAge: Math.floor(LAN_SESSION_MS / 1000),
        });
        deps.log?.("局域网后台登录成功");
        return c.json({ ok: true });
    }
  });

  app.post("/lan/logout", (c) => {
    lan.logout(sessionCookie(c));
    deleteCookie(c, LAN_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  /**
   * 设置或清空口令。只接受本机浏览器：拿到会话的局域网访客能改其余配置（用户选择的「完整管理」），
   * 但不能改掉口令把本人锁在外面，也不能关掉口令让整个局域网免登录。
   */
  app.post("/lan/password", async (c) => {
    if (!isLocalRequest(c)) return adminError(c, "invalid_request", "访问口令只能在本机后台修改");
    const body = await readJsonBody(c, LanPasswordRequestSchema);
    if (!body.ok) return body.response;
    const current = deps.configOf();
    const hash = body.data.password === null ? null : hashLanPassword(body.data.password);
    try {
      await deps.applyConfig({ ...current, gateway: { ...current.gateway, lanPasswordHash: hash } }, current);
    } catch (err) {
      return adminError(c, "write_failed", `口令写入失败:${safeErrorMessage(err)}`);
    }
    deps.log?.(hash === null ? "已关闭局域网访问口令" : "已设置局域网访问口令");
    return c.json({ ok: true });
  });

  return app;
}
