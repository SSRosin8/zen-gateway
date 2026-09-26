import { afterEach, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createApp } from "../../../src/server/app.ts";
import { EgressService } from "../../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../../src/shared/schema.ts";

/*
 * 转发链路集成测试共用的真实 HTTP 假上游。用真服务器而不是 mock fetch：
 * 「头已发出、字节流了一部分、然后断连」这种时序只有真实流式写出才能表达。
 */

export const TOKEN = "integration-test-token-x";

export type RelayUpstream = {
  port: number;
  /** 每个用例替换它来决定假上游的行为。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** 上游收到的请求 —— 断言「没有重试」靠它。 */
  calls: Array<{ url: string; headers: Record<string, unknown>; body: string }>;
  egress: EgressService;
  config(over?: Partial<Config>): Config;
  app(cfg?: Config): ReturnType<typeof createApp>;
};

/** 为当前测试文件注册假上游；返回的对象在每个用例前重置。 */
export function useRelayUpstream(): RelayUpstream {
  let server: Server;
  const up = {
    config(over: Partial<Config> = {}): Config {
      return ConfigSchema.parse({
        version: 1,
        gateway: {
          relayToken: TOKEN,
          baseUrl: `http://127.0.0.1:${up.port}/v1`,
          ...(over.gateway ?? {}),
        },
        workers: over.workers ?? [
          { id: "w1", name: "", kind: "authenticated", apiKey: "fake-key-1-not-real", enabled: true, proxyId: null },
        ],
        ...(over.proxies !== undefined ? { proxies: over.proxies } : {}),
        ...(over.models !== undefined ? { models: over.models } : {}),
      });
    },
    app(cfg: Config = up.config()) {
      return createApp({ configOf: () => cfg, egress: up.egress, log: () => {} });
    },
  } as RelayUpstream;

  beforeEach(async () => {
    up.calls = [];
    up.handler = (_req, res) => res.end("{}");

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        up.calls.push({
          url: req.url ?? "",
          headers: req.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        up.handler(req, res);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
    up.port = addr.port;

    up.egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });
  });

  afterEach(async () => {
    await up.egress.close();
    server.close();
    await once(server, "close");
  });

  return up;
}

export function relay(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}
