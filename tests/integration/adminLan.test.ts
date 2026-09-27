import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { LanStatusSchema } from "../../src/shared/contract.ts";
import { ConfigSchema } from "../../src/shared/schema.ts";
import { hashLanPassword, LanAccess, verifyLanPassword } from "../../src/server/admin/lanAccess.ts";
import { makeApp, makeConfig } from "./helpers/adminFixture.ts";

/*
 * 局域网访问管理后台的闸门与口令端点（app 层，注入回环对端 + 局域网 Host）。
 * 真实 socket 下「按真实对端判定」见 adminSite.test.ts。口令只能在本机设置。
 */

const LAN_HOST = "192.168.1.1:5173";
const PASSWORD = "fake-lan-password";

async function call(
  app: Hono,
  path: string,
  opts: { host?: string; origin?: string; cookie?: string; method?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.host !== undefined) headers["host"] = opts.host;
  if (opts.origin !== undefined) headers["origin"] = opts.origin;
  if (opts.cookie !== undefined) headers["cookie"] = opts.cookie;
  const res = await app.request(`http://${opts.host ?? "127.0.0.1"}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
    cookie: res.headers.get("set-cookie"),
  };
}

const lan = (path: string, extra: Parameters<typeof call>[2] = {}) => ({ path, opts: { host: LAN_HOST, ...extra } });

async function withPassword() {
  const fixture = makeApp(makeConfig());
  const set = await call(fixture.app, "/api/lan/password", { body: { password: PASSWORD } });
  expect(set.status).toBe(200);
  return fixture;
}

async function login(app: Hono): Promise<string> {
  const res = await call(app, "/api/lan/login", { host: LAN_HOST, body: { password: PASSWORD } });
  expect(res.status).toBe(200);
  const cookie = res.cookie ?? "";
  // 会话 cookie 前端脚本读不到，跨站不带。
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie.split(";")[0]!;
}

describe("口令哈希", () => {
  it("scrypt 哈希可验证，错误口令与损坏的哈希都不通过，且配置 schema 接受它", () => {
    const hash = hashLanPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(verifyLanPassword(PASSWORD, hash)).toBe(true);
    expect(verifyLanPassword("wrong-password", hash)).toBe(false);
    expect(verifyLanPassword(PASSWORD, "scrypt$broken")).toBe(false);
    const config = makeConfig();
    expect(ConfigSchema.safeParse({ ...config, gateway: { ...config.gateway, lanPasswordHash: hash } }).success).toBe(true);
  });
});

describe("局域网请求的闸门", () => {
  it("未开启时局域网 Host 一律 403，本机不受影响", async () => {
    const { app } = makeApp(makeConfig());
    const { path, opts } = lan("/api/overview");
    expect((await call(app, path, opts)).status).toBe(403);
    expect((await call(app, "/api/overview")).status).toBe(200);
  });

  it("开启后：未登录 401，登录后与本机权限相同，登出后回到 401", async () => {
    const { app, getConfig } = await withPassword();
    const denied = await call(app, "/api/overview", { host: LAN_HOST });
    expect(denied.status).toBe(401);
    expect((denied.body as { error: { type: string } }).error.type).toBe("lan_login_required");

    const cookie = await login(app);
    expect((await call(app, "/api/overview", { host: LAN_HOST, cookie })).status).toBe(200);
    // 完整管理：可以改配置。
    const patched = await call(app, "/api/config", {
      host: LAN_HOST,
      cookie,
      method: "PATCH",
      body: { gateway: { maxAttempts: 4 } },
    });
    expect(patched.status).toBe(200);
    expect(getConfig().gateway.maxAttempts).toBe(4);

    await call(app, "/api/lan/logout", { host: LAN_HOST, cookie, method: "POST" });
    expect((await call(app, "/api/overview", { host: LAN_HOST, cookie })).status).toBe(401);
  });

  it("状态与登录端点对局域网免会话；状态只对本机给出访问地址", async () => {
    const { app } = await withPassword();
    const remote = LanStatusSchema.parse((await call(app, "/api/lan/status", { host: LAN_HOST })).body);
    expect(remote).toEqual({ enabled: true, local: false, authenticated: false, addresses: [] });
    const local = LanStatusSchema.parse((await call(app, "/api/lan/status")).body);
    expect(local).toMatchObject({ enabled: true, local: true, authenticated: true });
  });

  it("TCP 对端不是回环时，即使带着有效会话也拒绝", async () => {
    const fixture = await withPassword();
    const cookie = await login(fixture.app);
    const other = makeApp(fixture.getConfig(), { address: "10.0.0.1" });
    expect((await call(other.app, "/api/overview", { host: LAN_HOST, cookie })).status).toBe(403);
  });

  it.each([
    ["域名 Host（DNS rebinding）", { host: "gateway.invalid:5173" }],
    ["公网 IP Host", { host: "203.0.113.9:5173" }],
    ["跨站 Origin", { host: LAN_HOST, origin: "http://10.1.2.3:8080" }],
  ])("%s 一律 403，不因会话放行", async (_label, opts) => {
    const { app } = await withPassword();
    const cookie = await login(app);
    expect((await call(app, "/api/overview", { ...opts, cookie })).status).toBe(403);
    expect((await call(app, "/api/lan/login", { ...opts, body: { password: PASSWORD } })).status).toBe(403);
  });

  it("同源 Origin 放行", async () => {
    const { app } = await withPassword();
    const cookie = await login(app);
    expect((await call(app, "/api/overview", { host: LAN_HOST, origin: `http://${LAN_HOST}`, cookie })).status).toBe(200);
  });
});

describe("口令管理", () => {
  it("局域网访客即使已登录也不能改口令或关闭局域网访问", async () => {
    const { app, getConfig } = await withPassword();
    const cookie = await login(app);
    const before = getConfig().gateway.lanPasswordHash;
    for (const password of ["another-password", null]) {
      const res = await call(app, "/api/lan/password", { host: LAN_HOST, cookie, body: { password } });
      expect(res.status).toBe(400);
    }
    expect(getConfig().gateway.lanPasswordHash).toBe(before);
  });

  it("更换口令后旧会话失效；关闭后局域网回到 403", async () => {
    const { app } = await withPassword();
    const cookie = await login(app);
    await call(app, "/api/lan/password", { body: { password: "a-new-fake-password" } });
    expect((await call(app, "/api/overview", { host: LAN_HOST, cookie })).status).toBe(401);

    await call(app, "/api/lan/password", { body: { password: null } });
    expect((await call(app, "/api/overview", { host: LAN_HOST, cookie })).status).toBe(403);
    expect((await call(app, "/api/lan/login", { host: LAN_HOST, body: { password: PASSWORD } })).status).toBe(403);
  });

  it("口令少于 8 位拒绝；响应与概览都不含口令或哈希", async () => {
    const { app, getConfig } = makeApp(makeConfig());
    expect((await call(app, "/api/lan/password", { body: { password: "short" } })).status).toBe(400);
    await call(app, "/api/lan/password", { body: { password: PASSWORD } });
    const hash = getConfig().gateway.lanPasswordHash!;
    const overview = JSON.stringify((await call(app, "/api/overview")).body);
    expect(overview).not.toContain(hash);
    expect(overview).not.toContain(PASSWORD);
  });
});

describe("登录失败锁定", () => {
  it("连续 5 次错误后锁定，锁定期内正确口令也拒绝，到期后恢复", () => {
    let now = 1_000_000;
    const hash = hashLanPassword(PASSWORD);
    const access = new LanAccess(() => hash, () => now);
    for (let i = 0; i < 4; i += 1) expect(access.login("wrong").kind).toBe("bad_password");
    expect(access.login("wrong").kind).toBe("locked");
    expect(access.login(PASSWORD).kind).toBe("locked");
    now += 61_000;
    const ok = access.login(PASSWORD);
    expect(ok.kind).toBe("ok");
    expect(access.valid(ok.kind === "ok" ? ok.token : undefined)).toBe(true);
  });

  it("会话 12 小时后过期", () => {
    let now = 0;
    const hash = hashLanPassword(PASSWORD);
    const access = new LanAccess(() => hash, () => now);
    const ok = access.login(PASSWORD);
    const token = ok.kind === "ok" ? ok.token : "";
    now += 12 * 3_600_000 - 1;
    expect(access.valid(token)).toBe(true);
    now += 1;
    expect(access.valid(token)).toBe(false);
  });
});
