import { describe, expect, it } from "vitest";
import { useStatsFixture } from "./helpers/statsFixture.ts";

/**
 * `x-zen-gateway-*` 诊断响应头在成功与失败两条转发路径上都存在。
 */

const { up, config, relay, makeApp, chatBody } = useStatsFixture();

describe("诊断头三个都在两条路径上", () => {
  /*
   * 「诊断手段只在一半路径可用」这个形态容易出现：`route`、`free`、`attempts`
   * 都曾只在一条路径上设置，而文档写着"前三个头在成功与失败时都有"。
   *
   * 这条测试同时钉住三个头在**两条路径**上都存在。
   */
  it("成功路径带 worker/route/attempts", async () => {
    const app = await makeApp(config());
    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    await res.text();

    expect(res.headers.get("x-zen-gateway-worker")).not.toBeNull();
    expect(res.headers.get("x-zen-gateway-route")).not.toBeNull();
    // 成功前试了几个 —— 多账号轮换下这是该被看见的信号。
    expect(res.headers.get("x-zen-gateway-attempts")).toBe("1");
  });

  it("成功前重试过时 attempts 反映真实次数", async () => {
    let n = 0;
    up.handler = (_req, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(500, {});
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x" }));
    };
    const app = await makeApp(config());
    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("x-zen-gateway-attempts")).toBe("2");
  });

  it("失败路径同样带三个头", async () => {
    up.handler = (_req, res) => {
      res.writeHead(500, {});
      res.end("{}");
    };
    const app = await makeApp(config());
    const res = await app.request("/v1/chat/completions", relay(chatBody()));
    await res.text();

    expect(res.headers.get("x-zen-gateway-attempts")).not.toBeNull();
    expect(res.headers.get("x-zen-gateway-route")).not.toBeNull();
    expect(res.headers.get("x-zen-gateway-worker")).not.toBeNull();
  });
});
