import { afterEach, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { EgressService } from "../../../src/core/proxy/egress.ts";
import { ModelCatalog, catalogIdentityOf } from "../../../src/core/models/catalog.ts";
import type { Config } from "../../../src/shared/schema.ts";

export type UpstreamCall = { url: string; method: string; headers: Record<string, unknown>; body: string };

export type FakeUpstream = {
  /** 当前监听的假上游。用例可以关掉它再换一个,afterEach 关的是最后那个。 */
  server: Server;
  port: number;
  /** 非目录请求交给它;每个用例可以替换。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** 上游收到的每次请求,包括目录查询。 */
  calls: UpstreamCall[];
  /** 假上游 GET /models 返回的在架目录。 */
  liveIds: string[];
  egress: EgressService;
  /** 转发请求(排除目录查询)。 */
  relayCalls(): UpstreamCall[];
  /** 用真实路径预热一个目录缓存,不碰私有字段。 */
  warmCatalog(cfg: Config): Promise<ModelCatalog>;
};

/**
 * 为当前测试文件注册一个真实 HTTP 假上游与一个 EgressService。
 *
 * 目录端点(`GET …/models`)由这里统一应答 `liveIds`,其余请求交给 `handler`。
 * 默认 handler 回一个带 `usage` 的 JSON 成功响应。
 */
export function useFakeUpstream(opts: {
  liveIds: readonly string[];
  usage: { prompt_tokens: number; completion_tokens: number };
}): FakeUpstream {
  const up = {
    calls: [],
    relayCalls() {
      return up.calls.filter((c) => c.method === "POST");
    },
    async warmCatalog(cfg: Config) {
      const catalog = new ModelCatalog();
      await catalog.ensure(catalogIdentityOf(cfg), cfg, (c) => up.egress.upstreamDeps(c));
      return catalog;
    },
  } as unknown as FakeUpstream;

  beforeEach(async () => {
    up.calls = [];
    up.liveIds = [...opts.liveIds];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", usage: opts.usage }));
    };

    up.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        up.calls.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers: req.headers as Record<string, unknown>,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: up.liveIds.map((id) => ({ id })) }));
          return;
        }
        up.handler(req, res);
      });
    });
    up.server.listen(0, "127.0.0.1");
    await once(up.server, "listening");
    const addr = up.server.address();
    if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
    up.port = addr.port;

    up.egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });
  });

  afterEach(async () => {
    await up.egress.close();
    up.server.close();
    await once(up.server, "close");
  });

  return up;
}
