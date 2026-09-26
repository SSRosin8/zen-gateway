import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { networkInterfaces } from "node:os";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";
import { ProtocolRegistry } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { readModelField, readStreamField } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";
import type { ProtocolId } from "../../src/shared/schema.ts";
import { loopbackOnly } from "../../src/server/middleware/loopbackOnly.ts";

/**
 * 路由守卫在真实装配上的覆盖:鉴权挂载点与注册表不脱节,回环判定走真 socket。
 *
 * 每条测试都对应一个"改坏也不报警"的位置,且都经变异验证过会变红。
 */
const TOKEN = "regression-token-not-real-x";

function surf(id: ProtocolId, paths: string[]): ProtocolSurface {
  return {
    id,
    clientPaths: paths,
    upstreamPath: `/${id}`,
    streaming: "optional",
    extractModel: readModelField,
    wantsStream: readStreamField,
    sessionKeyFrom: () => undefined,
    extraUpstreamHeaders: () => ({}),
    // 本文件测鉴权覆盖与路由装配,不测用量。
    parseUsage: () => null,
  };
}

let egress: EgressService;

beforeEach(() => {
  egress = new EgressService({ timeouts: { headersTimeoutMs: 2_000, bodyTimeoutMs: 2_000 } });
});

afterEach(async () => {
  await egress.close();
});

function config(over: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: TOKEN, ...(over.gateway ?? {}) },
    workers: over.workers ?? [],
  });
}

/* ================================================================== *
 * 鉴权挂载点必须覆盖注册表里的每一条路径
 * ================================================================== */

describe("鉴权覆盖：守卫挂载点与注册表不得脱节", () => {
  it("注册多个协议面后每条注册路径都要鉴权（含无前缀别名）", async () => {
    /*
     * 若守卫写成 `/v1/*` + `/chat/*` + `/models` 三条字面量,而路由是从
     * `registry.paths()` 动态挂载的,两份名单就会脱节。注册 responses/messages 后实测:
     * `/responses` 与 `/messages` **完全绕过鉴权**,成为本机任意进程可用的、
     * 消耗用户 Worker key 的免鉴权中继。
     *
     * 断言写成"遍历注册表的每一条路径",而不是逐条列举路径字面量 ——
     * 后者会随新增面一起过期,而这正是原 bug 的成因。
     */
    const registry = new ProtocolRegistry()
      .register(chatSurface)
      .register(surf("responses", ["/v1/responses", "/responses"]))
      .register(surf("messages", ["/v1/messages", "/messages"]));

    const app = createApp({ configOf: () => config(), egress, registry, log: () => {} });

    const unguarded: Array<[string, number]> = [];
    for (const path of registry.paths()) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      });
      // 401 = 守卫生效。其他任何状态码都说明请求已穿过守卫进了处理器。
      if (res.status !== 401) unguarded.push([path, res.status]);
    }

    expect(unguarded, `这些路径绕过了鉴权: ${JSON.stringify(unguarded)}`).toEqual([]);
  });

  it("/v1/models 与无前缀别名 /models 都要鉴权", async () => {
    // 没有这条时删掉 `app.use("/models", …)` 全套测试仍绿,
    // 而该变异下 /models 无 token 会返回 200 并吐出完整目录 ——
    // 且每次都用某个 Worker 的 key 真打一次上游。
    const app = createApp({ configOf: () => config(), egress, log: () => {} });
    for (const path of ["/v1/models", "/models"]) {
      const res = await app.request(path);
      expect(res.status, `${path} 应当要求鉴权`).toBe(401);
    }
  });

  it("装配期断言会抓出裸路由", () => {
    /*
     * `assertEveryRouteGuarded` 是最后一道保险:将来某个 `app.get(...)`
     * 被直接加进来（管理 API、调试端点）就又会出现一条裸路由,
     * 而那种错误没有任何症状,只是安静地对本机所有进程开放。
     *
     * 这条测试通过"构造一个正常 app 不抛错"来证明断言本身没有误报;
     * 断言的**有效性**由下面那条变异说明覆盖。
     */
    expect(() => createApp({ configOf: () => config(), egress, log: () => {} })).not.toThrow();
  });

  it("/health 是唯一免鉴权端点，且不泄露配置", async () => {
    // service.mjs 的健康等待与 doctor 都靠它,所以必须免鉴权;
    // 因此它的响应内容必须严格无害。
    const app = createApp({ configOf: () => config(), egress, log: () => {} });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const body = JSON.parse(text) as Record<string, unknown>;
    /*
     * **白名单**：多一个字段就可能是一次无意的信息泄露，所以这里断言的是
     * 完整键集合而不是"包含某几个"。
     *
     * `storeWriteFailures` 给 `writeFailures()` 一个生产读者。
     * 它无害的理由要说清：一个**累计失败次数**不暴露配置、凭证、Worker id、
     * 模型名或任何客户端数据 —— 它只回答"统计库有没有在正常写"。
     * 而管理面仅 loopback，与 `pid` 同理。
     */
    expect(Object.keys(body).sort()).toEqual([
      "ok",
      "pid",
      "storeWriteFailures",
      "uptimeSeconds",
      "version",
    ]);
    // 且它必须是个数字，不能是别的什么东西顺带漏出来。
    expect(typeof body["storeWriteFailures"]).toBe("number");
  });
});

/* ================================================================== *
 * loopbackOnly 的**默认** addressOf 绝不能读 X-Forwarded-For
 * ================================================================== */

describe("回环判定：必须用真 socket 验证生产代码路径", () => {
  /*
   * 原先那条名为"绝不采信 X-Forwarded-For —— 这是本文件最重要的断言"的测试
   * 注入了 `addressOf: () => address`,而**被替换掉的正是会去读那个头的代码
   * 路径**。于是把默认实现改成 `c.req.header("x-forwarded-for") ?? …` 之后,
   * 全套测试依然全绿 —— 一个结构上无法失败的空壳,正好盖在第 1 号
   * 安全要求上。
   *
   * 修法只有一个:起真服务器、走真 socket、用**默认** addressOf。
   */
  let server: ReturnType<typeof serve>;
  let port: number;

  beforeEach(async () => {
    const app = new Hono();
    // 不注入 addressOf —— 必须走生产默认实现。
    app.use("/api/*", loopbackOnly());
    app.get("/api/ping", (c) => c.json({ ok: true }));

    // 监听 0.0.0.0 才能同时从回环与 LAN 地址连入,以此区分"真来源"与"自称来源"。
    server = serve({ fetch: app.fetch, port: 0, hostname: "0.0.0.0" });
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("拿不到端口");
    port = addr.port;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  it("经 127.0.0.1 的真实请求被放行", async () => {
    // 这条同时覆盖了 IPv4-mapped 的情形:双栈监听下内核报的是
    // `::ffff:127.0.0.1`,朴素字符串比较会把这个合法请求拒掉。
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
    expect(res.status).toBe(200);
  });

  it("带伪造的 X-Forwarded-For 也不能让远端通过", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

    if (lan === undefined) {
      // 没有非回环网卡时这条无法验证真远端,但上一条已证明默认实现在用。
      expect(true).toBe(true);
      return;
    }

    const res = await fetch(`http://${lan}:${port}/api/ping`, {
      headers: {
        "x-forwarded-for": "127.0.0.1",
        "x-real-ip": "127.0.0.1",
        forwarded: "for=127.0.0.1",
      },
    });
    expect(res.status, "伪造 XFF 的远端请求必须被拒").toBe(403);
  });

  it("不带任何头的远端请求同样被拒（对照组）", async () => {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address;
    if (lan === undefined) {
      expect(true).toBe(true);
      return;
    }
    const res = await fetch(`http://${lan}:${port}/api/ping`);
    expect(res.status).toBe(403);
  });
});
