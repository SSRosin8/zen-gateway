import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { extractBearer, relayAuth, secureCompare } from "../../src/server/middleware/relayAuth.ts";
import { isLoopbackAddress, loopbackOnly } from "../../src/server/middleware/loopbackOnly.ts";

const TOKEN = "test-relay-token-not-real";

function authApp(token = TOKEN): Hono {
  const app = new Hono();
  app.use("/v1/*", relayAuth({ tokenOf: () => token }));
  app.get("/v1/ok", (c) => c.json({ ok: true }));
  return app;
}

describe("定长比较", () => {
  it("相等为真", () => {
    expect(secureCompare("abc", "abc")).toBe(true);
  });

  it.each([
    ["内容不同", "abd", "abc"],
    ["长度不同（短）", "ab", "abc"],
    ["长度不同（长）", "abcd", "abc"],
    ["空 vs 非空", "", "abc"],
    ["大小写不同", "ABC", "abc"],
  ])("不等为假（%s）", (_label, a, b) => {
    expect(secureCompare(a, b)).toBe(false);
  });

  it("长度不同时不抛 —— timingSafeEqual 对长度不等会抛，必须先挡住", () => {
    /*
     * 这是实现上的真实陷阱：node 的 timingSafeEqual 在长度不等时抛
     * ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH。若不先比长度，一个长度不对的
     * token 会让中间件抛异常 → 500，而正确行为是 401。
     */
    expect(() => secureCompare("a", "aaaaaaaaaaaaaaaaaaaa")).not.toThrow();
  });

  it("多字节字符按字节比较，不因编码长度不同而抛", () => {
    expect(() => secureCompare("中文", "abcdef")).not.toThrow();
    expect(secureCompare("中文", "中文")).toBe(true);
  });
});

describe("Bearer 提取", () => {
  it.each([
    ["标准", "Bearer abc", "abc"],
    ["小写 scheme", "bearer abc", "abc"],
    ["混合大小写", "BeArEr abc", "abc"],
    ["值含点与横线", "Bearer a.b-c_d", "a.b-c_d"],
  ])("接受（%s）", (_label, header, expected) => {
    expect(extractBearer(header)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["空串", ""],
    ["只有 scheme", "Bearer"],
    ["scheme 后无值", "Bearer "],
    ["Basic 认证", "Basic abc"],
    ["无 scheme", "abc"],
  ])("拒绝（%s）", (_label, header) => {
    expect(extractBearer(header)).toBeNull();
  });
});

describe("relayAuth 中间件", () => {
  it("带对 token 放行", async () => {
    const res = await authApp().request("/v1/ok", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ["不带 Authorization", {}],
    ["token 错", { authorization: "Bearer wrong-token-value-xx" }],
    ["格式错", { authorization: TOKEN }],
    ["空 Bearer", { authorization: "Bearer " }],
  ])("拒绝并返回 401（%s）", async (_label, headers) => {
    const res = await authApp().request("/v1/ok", { headers });
    expect(res.status).toBe(401);
  });

  it("失败措辞一致 —— 不区分「没带」与「带错」", async () => {
    /*
     * 区分开会告诉探测者他走到了哪一步；对合法用户这几种情况的处置是同一个：
     * 去检查配置里的 relayToken。
     */
    const a = await (await authApp().request("/v1/ok")).json();
    const b = await (
      await authApp().request("/v1/ok", { headers: { authorization: "Bearer nope-nope-nope-xx" } })
    ).json();
    expect(a).toEqual(b);
  });

  it("响应体不回显期望的 token", async () => {
    const res = await authApp().request("/v1/ok");
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("token 变更后立即生效 —— tokenOf 是函数而非快照", async () => {
    let current = "first-token-value-here";
    const app = new Hono();
    app.use("/v1/*", relayAuth({ tokenOf: () => current }));
    app.get("/v1/ok", (c) => c.json({ ok: true }));

    expect((await app.request("/v1/ok", { headers: { authorization: "Bearer first-token-value-here" } })).status).toBe(200);
    current = "second-token-value-xx";
    expect((await app.request("/v1/ok", { headers: { authorization: "Bearer first-token-value-here" } })).status).toBe(401);
    expect((await app.request("/v1/ok", { headers: { authorization: "Bearer second-token-value-xx" } })).status).toBe(200);
  });
});

describe("回环判定", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "127.1.2.3",
    "127.255.255.254",
    "::1",
  ])("回环地址通过：%s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  it.each([
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("IPv4-mapped 回环通过：%s", (addr) => {
    /*
     * 这是实测发现的真实陷阱：双栈监听下，客户端经 127.0.0.1 连来时
     * getConnInfo 报的是 `::ffff:127.0.0.1`。朴素的
     * `addr === "127.0.0.1" || addr === "::1"` 会把这个**合法的本机请求**拒掉。
     */
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  it.each([
    "128.0.0.1",
    "10.0.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "8.8.8.8",
    "126.255.255.255",
    "fe80::1",
    "2001:db8::1",
    "::",
    "::ffff:8.8.8.8",
  ])("非回环地址被拒：%s", (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["空串", ""],
    ["非 IP 文本", "localhost"],
    ["垃圾值", "not-an-ip"],
    ["带端口", "127.0.0.1:8080"],
    ["前导零形式", "127.0.0.01"],
  ])("认不出的来源默认拒绝（%s）", (_label, addr) => {
    // 认不出来的来源不该被当作本机 —— 默认拒绝。
    expect(isLoopbackAddress(addr)).toBe(false);
  });
});

describe("loopbackOnly 中间件", () => {
  function app(address: string | undefined): Hono {
    const a = new Hono();
    a.use("/api/*", loopbackOnly({ addressOf: () => address }));
    a.get("/api/ping", (c) => c.json({ ok: true }));
    return a;
  }

  it("本机放行", async () => {
    expect((await app("127.0.0.1").request("/api/ping")).status).toBe(200);
  });

  it("IPv4-mapped 本机放行", async () => {
    expect((await app("::ffff:127.0.0.1").request("/api/ping")).status).toBe(200);
  });

  it("远端返回 403", async () => {
    expect((await app("203.0.113.9").request("/api/ping")).status).toBe(403);
  });

  it("绝不采信 X-Forwarded-For —— 这是本文件最重要的断言", async () => {
    /*
     * 该头由客户端任意设置。若用它判断来源，一个远端请求只要带上
     * `X-Forwarded-For: 127.0.0.1` 就能拿到管理面权限。
     * 唯一可信的证据是内核报告的 TCP 对端地址。
     */
    const res = await app("203.0.113.9").request("/api/ping", {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
      },
    });
    expect(res.status).toBe(403);
  });

  it("取不到对端地址时拒绝 —— 探测失败不等于可以放行", async () => {
    const a = new Hono();
    a.use("/api/*", loopbackOnly({ addressOf: () => { throw new Error("no conn info"); } }));
    a.get("/api/ping", (c) => c.json({ ok: true }));
    expect((await a.request("/api/ping")).status).toBe(403);
  });

  it("403 响应不回显对端地址", async () => {
    const res = await app("203.0.113.9").request("/api/ping");
    expect(await res.text()).not.toContain("203.0.113.9");
  });
});
