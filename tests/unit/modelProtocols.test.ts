import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ProtocolDeclarations,
  parseModelsDev,
  protocolOfNpm,
} from "../../src/core/models/protocols.ts";
import { openDb } from "../../src/store/db/open.ts";
import { StatsStore } from "../../src/store/db/stats.ts";

/** models.dev `api.json` 的最小形状；id 与包名是虚构的，只保留结构。 */
function payload(models: Record<string, unknown>, npm: string | null = "@ai-sdk/openai-compatible") {
  return { "other-provider": { models: {} }, opencode: { id: "opencode", ...(npm === null ? {} : { npm }), models } };
}

describe("包名 → 协议", () => {
  it("OpenCode 的三个包对应网关的三个面", () => {
    expect(protocolOfNpm("@ai-sdk/openai-compatible")).toBe("chat");
    expect(protocolOfNpm("@ai-sdk/openai")).toBe("responses");
    expect(protocolOfNpm("@ai-sdk/anthropic")).toBe("messages");
  });

  it("网关没有对应面的包记为 other，不猜成某个面", () => {
    expect(protocolOfNpm("@ai-sdk/google")).toBe("other");
    // 原型链上的名字不能被当成映射命中。
    expect(protocolOfNpm("toString")).toBe("other");
  });

  it("没有包名就是未声明", () => {
    expect(protocolOfNpm(undefined)).toBeNull();
    expect(protocolOfNpm("")).toBeNull();
  });
});

describe("解析 models.dev", () => {
  it("模型级 provider.npm 优先，缺省时回落到 provider 级 npm", () => {
    const map = parseModelsDev(
      payload({
        "a-free": {},
        "b-model": { provider: { npm: "@ai-sdk/anthropic" } },
        "c-model": { provider: { npm: "@ai-sdk/google" } },
        "d-model": { provider: {} },
      }),
    );
    expect(map).not.toBeNull();
    expect(Object.fromEntries(map!)).toEqual({
      "a-free": "chat",
      "b-model": "messages",
      "c-model": "other",
      "d-model": "chat",
    });
  });

  it("provider 级也没有 npm 时是未声明（null），不是默认 chat", () => {
    const map = parseModelsDev(payload({ "a-free": {} }, null));
    expect(map!.get("a-free")).toBeNull();
  });

  it.each([
    ["缺 opencode", { x: {} }],
    ["models 不是对象", { opencode: { models: [] } }],
    ["空 models", payload({})],
    ["npm 不是字符串", payload({ a: { provider: { npm: 1 } } })],
  ])("不可采纳：%s", (_label, body) => {
    expect(parseModelsDev(body)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 缓存、体积上限、超时与退避：对本机假服务
 * ------------------------------------------------------------------ */

type Handler = (res: ServerResponse) => void;
let server: Server;
let url: string;
let handler: Handler;
let hits = 0;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.json`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
});

const ok = (body: unknown): Handler => (res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("ProtocolDeclarations", () => {
  it("拉取成功后缓存，TTL 内不再请求", async () => {
    let now = 1_000_000;
    handler = ok(payload({ "a-free": {} }));
    const d = new ProtocolDeclarations({ url, clock: () => now });
    expect(d.cached()).toBeNull();

    await d.refreshIfStale();
    expect(d.cached()!.byModel.get("a-free")).toBe("chat");
    expect(d.cached()!.fetchedAt).toBe(now);

    now += 60 * 60 * 1000;
    expect(d.refreshIfStale()).toBeNull();
    expect(hits).toBe(1);

    // 过了 6 小时才再拉。
    now += 6 * 60 * 60 * 1000;
    await d.refreshIfStale();
    expect(hits).toBe(2);
  });

  it("失败后退避：退避期内不打第三方，期满再试；失败不抹掉旧缓存", async () => {
    let now = 1_000_000;
    handler = ok(payload({ "a-free": {} }));
    const d = new ProtocolDeclarations({ url, clock: () => now });
    await d.refreshIfStale();

    handler = (res) => {
      res.writeHead(503);
      res.end();
    };
    now += 7 * 60 * 60 * 1000;
    await d.refreshIfStale();
    expect(hits).toBe(2);
    expect(d.cached()!.byModel.get("a-free")).toBe("chat");

    now += 60_000;
    expect(d.refreshIfStale()).toBeNull();
    expect(hits).toBe(2);

    now += 5 * 60 * 1000;
    await d.refreshIfStale();
    expect(hits).toBe(3);
  });

  it("并发调用合流成一次请求", async () => {
    handler = ok(payload({ "a-free": {} }));
    const d = new ProtocolDeclarations({ url });
    await Promise.all([d.refreshIfStale(), d.refreshIfStale(), d.refreshIfStale()]);
    expect(hits).toBe(1);
  });

  it("响应超过体积上限时边读边中止，不采纳", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let written = 0;
    handler = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // 不给 content-length，只能边读边数才挡得住。
      const pump = () => {
        while (written < 64 * 1024 * 1024) {
          written += chunk.byteLength;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => {});
      pump();
    };
    const logs: string[] = [];
    const d = new ProtocolDeclarations({ url, log: (m) => logs.push(m) });
    await d.refreshIfStale();
    expect(d.cached()).toBeNull();
    expect(logs.join("\n")).toMatch(/超过/);
    // 在写完 64 MiB 之前就停了读。
    expect(written).toBeLessThan(64 * 1024 * 1024);
  });

  it("超时后放弃，不无限等待", async () => {
    handler = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{"); // 只给头和一个字节，然后挂住。
    };
    const d = new ProtocolDeclarations({ url, timeoutMs: 200 });
    const started = Date.now();
    await d.refreshIfStale();
    expect(d.cached()).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("非法 JSON 或未通过校验时不采纳", async () => {
    handler = (res) => {
      res.writeHead(200);
      res.end("not json");
    };
    const d = new ProtocolDeclarations({ url });
    await d.refreshIfStale();
    expect(d.cached()).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 实测协议：统计库查询
 * ------------------------------------------------------------------ */

describe("StatsStore.modelProtocols", () => {
  let root: string;
  let db: DatabaseSync;
  let stats: StatsStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zg-protocols-"));
    await mkdir(join(root, "data"), { recursive: true });
    db = openDb(join(root, "data", "runtime.db"));
    stats = new StatsStore(db);
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const DAY = Date.parse("2026-06-15T12:00:00Z");
  function attempt(model: string | null, protocol: string, status: number | null, at = DAY) {
    stats.recordAttempt({
      requestId: `r-${Math.random()}`,
      attemptIndex: 0,
      workerId: "w1",
      protocol,
      model,
      status,
      failureKind: null,
      latencyMs: 1,
      at,
    });
  }

  it("只算 2xx 的尝试，按模型去重排序", () => {
    attempt("a-free", "responses", 200);
    attempt("a-free", "chat", 201);
    attempt("a-free", "chat", 200);
    attempt("a-free", "messages", 403);
    attempt("b-free", "messages", 500);
    attempt("c-free", "messages", null);
    attempt(null, "chat", 200);
    const map = stats.modelProtocols();
    expect(Object.fromEntries(map)).toEqual({ "a-free": ["chat", "responses"] });
  });

  it("sinceDay 过滤掉更早的尝试", () => {
    attempt("a-free", "chat", 200, Date.parse("2026-06-10T12:00:00Z"));
    attempt("a-free", "messages", 200, DAY);
    expect(stats.modelProtocols("2026-06-15").get("a-free")).toEqual(["messages"]);
    expect(stats.modelProtocols("2026-06-16").size).toBe(0);
  });
});
