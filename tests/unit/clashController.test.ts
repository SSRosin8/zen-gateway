import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ClashController, ControllerError } from "../../src/core/proxy/clash/controller.ts";

/*
 * 用真实的本机 HTTP 服务而非 mock fetch:要验证的正是 URL 拼接与编码,
 * 而 mock 掉 fetch 就把待测的那一层换掉了。
 */

type Recorded = { method: string; url: string; body: string };

let server: Server;
let origin: string;
let recorded: Recorded[];
/** 各用例覆写:决定服务端如何应答。 */
let respond: (req: IncomingMessage, res: ServerResponse, body: string) => void;

beforeEach(async () => {
  recorded = [];
  respond = (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}");

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      recorded.push({ method: req.method ?? "", url: req.url ?? "", body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const make = (apiSecret = "", apiBase?: string) =>
  new ClashController({ id: "b1", apiBase: apiBase ?? origin, apiSecret }, { timeoutMs: 3_000 });

const json = (payload: unknown) => (_req: IncomingMessage, res: ServerResponse) =>
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));

describe("鉴权", () => {
  it("有 secret 时发 Bearer 头", async () => {
    let auth: string | undefined;
    respond = (req, res) => {
      auth = req.headers.authorization;
      json({ version: "1.10.0", meta: true })(req, res);
    };
    await make("fake-secret-value").version();
    expect(auth).toBe("Bearer fake-secret-value");
  });

  it("没有 secret 时不发 Authorization 头", async () => {
    let hasAuth = true;
    respond = (req, res) => {
      hasAuth = req.headers.authorization !== undefined;
      json({ version: "1.10.0" })(req, res);
    };
    await make("").version();
    expect(hasAuth).toBe(false);
  });

  it("401/403 的错误信息不回显 secret", async () => {
    respond = (_req, res) => res.writeHead(403).end("forbidden");
    const err = (await make("SUPER-SECRET-abc123")
      .version()
      .catch((e: unknown) => e)) as ControllerError;

    expect(err).toBeInstanceOf(ControllerError);
    expect(err.kind).toBe("auth");
    // secret 是凭证,任何错误路径都不得回显。
    expect(err.message).not.toContain("SUPER-SECRET-abc123");
    expect(err.message).toContain("apiSecret");
  });
});

describe("version", () => {
  it("解析 mihomo 的 meta 标记", async () => {
    respond = json({ version: "1.10.0", meta: true });
    await expect(make().version()).resolves.toEqual({ version: "1.10.0", isMeta: true });
  });

  it("原版 Clash 没有 meta 字段", async () => {
    respond = json({ version: "1.18.0" });
    await expect(make().version()).resolves.toEqual({ version: "1.18.0", isMeta: false });
  });

  it("响应不是 JSON 时报 bad_response", async () => {
    respond = (_req, res) => res.writeHead(200).end("<html>not json</html>");
    const err = (await make().version().catch((e: unknown) => e)) as ControllerError;
    expect(err.kind).toBe("bad_response");
  });

  it("连不上时报 unreachable", async () => {
    // 127.0.0.1:9 —— 几乎肯定没人监听。
    const err = (await make("", "http://127.0.0.1:9")
      .version()
      .catch((e: unknown) => e)) as ControllerError;
    expect(err.kind).toBe("unreachable");
  });

  it("apiBase 末尾斜杠不会拼出 //version", async () => {
    respond = json({ version: "1.10.0" });
    await make("", `${origin}/`).version();
    expect(recorded[0]!.url).toBe("/version");
  });
});

describe("selectors", () => {
  it("只返回 Selector 类型的分组", async () => {
    respond = json({
      proxies: {
        GLOBAL: { type: "Selector", now: "节点 A", all: ["节点 A", "节点 B"] },
        Proxy: { type: "Selector", now: "节点 B", all: ["节点 B"] },
        "自动选择": { type: "URLTest", now: "节点 A", all: ["节点 A"] },
        DIRECT: { type: "Direct" },
        "节点 A": { type: "AnyTLS" },
      },
    });

    const groups = await make().selectors();
    expect(groups.map((g) => g.name)).toEqual(["GLOBAL", "Proxy"]);
    expect(groups[0]!.options).toEqual(["节点 A", "节点 B"]);
    expect(groups[0]!.now).toBe("节点 A");
  });

  it("容忍缺失的 now 与 all", async () => {
    respond = json({ proxies: { GLOBAL: { type: "Selector" } } });
    const groups = await make().selectors();
    expect(groups[0]).toEqual({ name: "GLOBAL", now: "", options: [] });
  });

  it("all 里的非字符串项被过滤", async () => {
    respond = json({ proxies: { G: { type: "Selector", now: "a", all: ["a", 42, null, "b"] } } });
    const groups = await make().selectors();
    expect(groups[0]!.options).toEqual(["a", "b"]);
  });

  it("proxies 不是对象时报 bad_response", async () => {
    respond = json({ proxies: "nope" });
    const err = (await make().selectors().catch((e: unknown) => e)) as ControllerError;
    expect(err.kind).toBe("bad_response");
  });
});

describe("nodes", () => {
  it("排除分组与内置策略,只留可出口节点", async () => {
    respond = json({
      proxies: {
        GLOBAL: { type: "Selector", now: "n1", all: ["n1"] },
        "自动": { type: "URLTest" },
        "故障转移": { type: "Fallback" },
        DIRECT: { type: "Direct" },
        REJECT: { type: "Reject" },
        PASS: { type: "Pass" },
        COMPATIBLE: { type: "Compatible" },
        n1: { type: "AnyTLS", history: [{ delay: 231 }] },
        n2: { type: "Vmess", history: [] },
      },
    });

    const nodes = await make().nodes();
    expect(nodes.map((n) => n.name)).toEqual(["n1", "n2"]);
    expect(nodes[0]!.latencyMs).toBe(231);
    // 没有历史记录时如实为 null,不猜一个数。
    expect(nodes[1]!.latencyMs).toBeNull();
  });

  it("delay 为 0 视为不可用而非 0ms", async () => {
    // Clash 用 0 表示测速失败。
    respond = json({ proxies: { n1: { type: "AnyTLS", history: [{ delay: 0 }] } } });
    const nodes = await make().nodes();
    expect(nodes[0]!.latencyMs).toBeNull();
  });

  it("取历史里最后一条延迟", async () => {
    respond = json({
      proxies: { n1: { type: "AnyTLS", history: [{ delay: 900 }, { delay: 120 }] } },
    });
    const nodes = await make().nodes();
    expect(nodes[0]!.latencyMs).toBe(120);
  });
});

describe("select", () => {
  it("节点名含空格/冒号/emoji 时正确编码", async () => {
    /*
     * 实测本机 mihomo 的节点名带这些结构性麻烦:空格、冒号、emoji
     * (国旗是多码点序列)、连续空格。不编码会产生非法 URL 或指向错误资源。
     * 这里的名字是虚构的,但逐项保留了那些麻烦 —— 真实订阅的节点名与
     * 服务商域名不进仓库。
     */
    const node = "🇺🇲 示例节点2 IPLC  VIP2 网址:example.invalid";
    respond = (_req, res) => res.writeHead(204).end();

    await make().select("GLOBAL", node);

    const call = recorded[0]!;
    expect(call.method).toBe("PUT");
    // path 里不得出现裸空格或裸冒号。
    expect(call.url).not.toMatch(/ /);
    expect(call.url.split("?")[0]).not.toContain(":");
    // 解码后应还原成原名。
    expect(decodeURIComponent(call.url.replace("/proxies/", ""))).toBe("GLOBAL");
    expect(JSON.parse(call.body)).toEqual({ name: node });
  });

  it("分组名含斜杠时也被编码", async () => {
    respond = (_req, res) => res.writeHead(204).end();
    await make().select("a/b", "n1");
    // 不编码会把 a/b 变成两级路径,指向完全不同的资源。
    expect(recorded[0]!.url).toBe("/proxies/a%2Fb");
  });

  it("分组不存在时报 not_found", async () => {
    respond = (_req, res) => res.writeHead(404).end();
    const err = (await make().select("没有", "n1").catch((e: unknown) => e)) as ControllerError;
    expect(err.kind).toBe("not_found");
  });
});

describe("currentNode", () => {
  it("读取选中节点", async () => {
    respond = json({ type: "Selector", now: "节点 B" });
    await expect(make().currentNode("GLOBAL")).resolves.toBe("节点 B");
  });

  it("不是 Selector 时报错", async () => {
    respond = json({ type: "AnyTLS" });
    const err = (await make().currentNode("n1").catch((e: unknown) => e)) as ControllerError;
    expect(err.kind).toBe("bad_response");
  });
});

describe("delay", () => {
  it("返回延迟毫秒", async () => {
    respond = json({ delay: 187 });
    await expect(make().delay("n1", "http://www.gstatic.com/generate_204")).resolves.toBe(187);
  });

  it("节点名与测试 URL 都正确编码", async () => {
    respond = json({ delay: 100 });
    await make().delay("🇭🇰 香港 01", "http://www.gstatic.com/generate_204");

    const url = recorded[0]!.url;
    expect(url).not.toMatch(/ /);
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("url")).toBe("http://www.gstatic.com/generate_204");
    expect(query.get("timeout")).toBe("5000");
  });

  it("节点不可用时返回 null 而非抛错", async () => {
    // 这不是 Controller 故障,如实返回 null。
    respond = (_req, res) => res.writeHead(408).end(JSON.stringify({ message: "timeout" }));
    await expect(make().delay("n1", "http://x.invalid")).resolves.toBeNull();
  });

  it("Controller 本身连不上时抛错,不静默当作节点不可用", async () => {
    // 「内核挂了」与「节点不通」是两种不同的故障,不能混。
    const err = await make("", "http://127.0.0.1:9")
      .delay("n1", "http://x.invalid")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControllerError);
  });
});
