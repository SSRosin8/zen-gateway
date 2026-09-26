import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { ClashController, ControllerError } from "../../src/core/proxy/clash/controller.ts";

/*
 * `runtimeConfig()` 是 setup 与 doctor 读 `/configs` 的唯一实现。
 * 用真实本机 HTTP 服务：要验证的是路径拼接、单次请求与字段归一化。
 */

let server: Server;
let origin: string;
let hits: string[];
let reply: { status: number; body: string };

beforeEach(async () => {
  hits = [];
  reply = { status: 200, body: "{}" };
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}/api`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const make = () => new ClashController({ id: "b1", apiBase: origin, apiSecret: "" }, { timeoutMs: 3_000 });

describe("ClashController.runtimeConfig", () => {
  it("一次 /configs 请求同时给出小写 mode 与 mixed-port", async () => {
    reply.body = JSON.stringify({ mode: "Rule", "mixed-port": 7897, "socks-port": 7891 });
    await expect(make().runtimeConfig()).resolves.toEqual({ mode: "rule", mixedPort: 7897 });
    expect(hits).toEqual(["/api/configs"]);
  });

  it("mixed-port 为 0 或缺失时为 null，不拿 socks-port / port 代替", async () => {
    reply.body = JSON.stringify({ mode: "global", "mixed-port": 0, "socks-port": 7891, port: 7890 });
    await expect(make().runtimeConfig()).resolves.toEqual({ mode: "global", mixedPort: null });

    reply.body = JSON.stringify({ "socks-port": 7891 });
    await expect(make().runtimeConfig()).resolves.toEqual({ mode: null, mixedPort: null });
  });

  it("非 JSON 对象的响应归一化为两项 null", async () => {
    reply.body = "null";
    await expect(make().runtimeConfig()).resolves.toEqual({ mode: null, mixedPort: null });
  });

  it("非 2xx 抛 ControllerError，由调用方决定默认值", async () => {
    reply = { status: 404, body: "{}" };
    await expect(make().runtimeConfig()).rejects.toBeInstanceOf(ControllerError);
  });
});
