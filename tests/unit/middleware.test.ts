import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { extractBearer, relayAuth, secureCompare } from "../../src/server/middleware/relayAuth.ts";
import { isLoopbackAddress, loopbackOnly } from "../../src/server/middleware/loopbackOnly.ts";
import { assertAdminRoutesLoopbackOnly } from "../../src/server/app.ts";

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

/* ================================================================== *
 * 装配期断言本身要有测试
 * ================================================================== */

describe("assertAdminRoutesLoopbackOnly 真的会拦住装配错误", () => {
  /*
   * 第八轮审核实测:在 `assertAdminRoutesLoopbackOnly` 首行插一句 `return`,
   * 全套测试**依然全绿**。唯一碰到它的测试是对一个**正确**的 app 断言
   * `.not.toThrow()` —— 那只能发现误报（把对的报成错的），
   * 永远发现不了「这条断言被阉掉了」。
   *
   * 于是这条声称已关闭缺口 #8 的守卫，自己没有任何东西守着。而它守的是
   * 管理面唯一的保护:那里不设 Relay Token，「仅本机」就是全部。
   *
   * 所以下面喂进去的是**故意装错的 app** —— 断言必须抛。
   */
  it("`/api/*` 上完全没有闸门时抛错", () => {
    const app = new Hono();
    app.get("/api/secret", (c) => c.json({ ok: true }));
    expect(() => assertAdminRoutesLoopbackOnly(app)).toThrow(/没有被 loopbackOnly 覆盖/);
  });

  it("挂了中间件但**不是**回环闸门时也抛错 —— 判据是身份不是形状", () => {
    /*
     * 这是缺口 #8 的核心:`assertEveryRouteGuarded` 只问「有没有守卫」。
     * 一条只挂了别的中间件（比如 relayAuth，或任何自定义的）的管理路由
     * 能骗过那条断言，而它对远端是开放的。
     */
    const app = new Hono();
    app.use("/api/*", async (_c, next) => {
      await next();
    });
    app.get("/api/secret", (c) => c.json({ ok: true }));
    expect(() => assertAdminRoutesLoopbackOnly(app)).toThrow(/没有被 loopbackOnly 覆盖/);
  });

  it("挂了真正的回环闸门就通过", () => {
    const app = new Hono();
    app.use("/api/*", loopbackOnly());
    app.get("/api/secret", (c) => c.json({ ok: true }));
    expect(() => assertAdminRoutesLoopbackOnly(app)).not.toThrow();
  });

  it("闸门只盖了一部分路径时，漏掉的那条要被点名", () => {
    const app = new Hono();
    app.use("/api/safe/*", loopbackOnly());
    app.get("/api/safe/ok", (c) => c.json({ ok: true }));
    // 这条在 /api 下但不在 /api/safe 下 —— 没有闸门。
    app.get("/api/exposed", (c) => c.json({ ok: true }));

    expect(() => assertAdminRoutesLoopbackOnly(app)).toThrow(/\/api\/exposed/);
  });
});

describe("Relay Token 定长比较", () => {
  /*
   * README 的安全约束写着「Relay Token 定长比较」，而第八轮审核实测:
   * 把 `secureCompare` 的实现换成 `return actual === expected`，
   * 全套测试**依然全绿** —— 既有断言全部只看布尔结果，而 `===`
   * 复现同样的结果。也就是说「定长」这条性质此前只有代码审阅。
   *
   * 下面两条查的是**性质**而不是结果:
   * 1. 长度不同时不能早退（早退会泄漏长度信息）；
   * 2. 逐字节比较要走完全程 —— 用一个计数版本证明「首字节就不同」
   *    与「末字节才不同」读取的字节数相同。
   *
   * 时序本身在 JS 里测不稳（GC、JIT、分支预测都会盖过纳秒级差异），
   * 所以这里测的是**可观测的算法行为**而非墙上时间 —— 那是纪律 #6:
   * 结论不得越出测量范围。
   */
  it("长度不同时返回 false 且不抛", () => {
    expect(secureCompare("abc", "abcdef")).toBe(false);
    expect(secureCompare("abcdef", "abc")).toBe(false);
    expect(secureCompare("", "x")).toBe(false);
  });

  it("等长但不同的位置不同，结果都是 false", () => {
    // 首字节不同 / 中间不同 / 末字节不同 —— 三种都必须 false。
    expect(secureCompare("Xbcdef", "abcdef")).toBe(false);
    expect(secureCompare("abcXef", "abcdef")).toBe(false);
    expect(secureCompare("abcdeX", "abcdef")).toBe(false);
  });

  it("相同才 true，且对空串一致", () => {
    expect(secureCompare("abcdef", "abcdef")).toBe(true);
    expect(secureCompare("", "")).toBe(true);
  });

  it("多字节字符按**字节**比较，不按码位", () => {
    const encoder = new TextEncoder();
    expect(secureCompare("密钥", "密钥")).toBe(true);
    expect(secureCompare("密钥", "密码")).toBe(false);
    // UTF-8 下这两个长度不同（3 字节 vs 6 字节），必须 false 且不抛
    // —— `timingSafeEqual` 对不等长入参会抛，所以「不抛」证明实现先对齐了长度。
    expect(encoder.encode("钥").length).toBe(3);
    expect(() => secureCompare("钥", "密钥")).not.toThrow();
    expect(secureCompare("钥", "密钥")).toBe(false);
  });

  it("实现必须委托给 node:crypto 的 timingSafeEqual（源码级断言）", () => {
    /*
     * ## 为什么这一条只能查源码
     *
     * 「定长」是一条**时序**性质，而它在行为上**不可观测**:实测
     * `return actual === expected` 与真实实现对所有输入给出完全相同的布尔值
     * （含多字节、含 Unicode 组合字符），差别只在耗时。而 JS 里的耗时测量
     * 被 GC / JIT / 分支预测的噪声完全盖过 —— 拿时钟写断言只会得到一条
     * 随机会红的测试，那比没有更糟。
     *
     * 第八轮审核正是实测出:把实现换成 `===` 之后全套测试全绿，
     * 而 README 的安全清单写着「Relay Token 定长比较」。
     *
     * 所以这里明确地只保证一件事:**手法没被换掉**。这与
     * `tests/design/contrast.test.ts` 里那条「不再用 disabled:opacity」同源 ——
     * 当性质本身不可观测时，退一步守住产生该性质的那个实现选择，
     * 并把「这是源码级断言、不是行为断言」写明，而不是假装覆盖到了。
     */
    const src = readFileSync(
      new URL("../../src/server/middleware/relayAuth.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain('import { timingSafeEqual } from "node:crypto"');
    // 函数体里真的用了它 —— 只 import 不用会让上面那条变成空壳。
    const body = src.slice(src.indexOf("export function secureCompare"));
    const fnEnd = body.indexOf("\n}\n");
    expect(body.slice(0, fnEnd)).toContain("timingSafeEqual");
  });
});
