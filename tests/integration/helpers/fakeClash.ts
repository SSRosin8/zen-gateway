import { createServer, type Server } from "node:http";

/**
 * 回环上的假 Clash Controller，端口由系统分配。只实现发现与导入会问的几条：
 * `/version`、`/configs`、`/proxies`、`/rules`。`secret` 非空时校验 Bearer。
 */
export type FakeClash = {
  readonly apiBase: string;
  /** 收到的请求路径，断言「根本没被联系」或「确实问过 /configs」用。 */
  readonly hits: string[];
  close(): Promise<void>;
};

export async function startFakeClash(
  opts: { secret?: string; mixedPort?: number; nodes?: string[]; group?: string } = {},
): Promise<FakeClash> {
  const secret = opts.secret ?? "";
  const nodes = opts.nodes ?? ["节点 A", "节点 B", "节点 C"];
  const group = opts.group ?? "Proxy";
  const hits: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname);
    if (secret !== "" && req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/version") return json({ version: "v1.19.31", meta: true });
    if (url.pathname === "/configs") return json({ mode: "rule", "mixed-port": opts.mixedPort ?? 7897 });
    if (url.pathname === "/rules") return json({ rules: [{ type: "Match", payload: "", proxy: group }] });
    if (url.pathname === "/proxies") {
      const proxies: Record<string, unknown> = {};
      for (const name of nodes) proxies[name] = { type: "AnyTLS", history: [] };
      proxies[group] = { type: "Selector", now: nodes[0] ?? "", all: nodes };
      proxies["GLOBAL"] = { type: "Selector", now: group, all: [group, ...nodes] };
      proxies["DIRECT"] = { type: "Direct" };
      return json({ proxies });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    apiBase: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
