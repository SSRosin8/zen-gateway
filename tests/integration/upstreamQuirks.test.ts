import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";

const execFileAsync = promisify(execFile);
const PROJECT = resolve(import.meta.dirname, "..", "..");

/**
 * 上游协议发现的回归守卫。
 *
 * ## 脚本为什么不做字段级发现,原因写在 docs/upstream-quirks.md
 *
 * 「逐字段定位被拒原因」实测做不到:
 * 免费额度闸门**短路在请求体校验之前**(把 `messages` 写成字符串再塞一个
 * `client_metadata`,响应与合法请求逐字节相同),所以字段级怪癖探不到;
 * 而另一条路(付费模型能过体校验)要真实计费,超出本网关的范围。
 *
 * 于是脚本改做「闸门与错误形状的重验」。**但那让脚本自己成了一道关卡** ——
 * 它声称"上游行为一变就退出 1"。按 [[verification-discipline]] 第 1 条,
 * 这个声称必须被证明**真的会失败**,否则它就是一个永远绿的空壳,
 * 而那比没有这个脚本更糟:它会让人以为上游行为被监测着。
 *
 * 所以本文件用一个**本地假上游**驱动那个脚本:先证明它在行为符合预期时退出 0,
 * 再逐条改变假上游的行为,证明每一条都能让它退出 1。不需要网络。
 */

/* ================================================================== *
 * 假上游 —— 复刻实测出的三段闸门
 * ================================================================== */

/**
 * 复刻真实 Zen 的闸门顺序:**存在性 → key 语法 → 免费闸门 → 密钥验证**。
 *
 * 这个顺序是实测出来的,每一步都有依据(见 docs/upstream-quirks.md §2、§4):
 * - `bogus` + 不存在的模型 → `ModelError`(不是 AuthError)⇒ 存在性在语法之前
 * - `bogus` + 免费模型 → `AuthError` ⇒ 语法在免费闸门之前
 * - 语法合法但密钥错 + 免费模型 → `FreeTierError` ⇒ 免费闸门在密钥验证之前
 * - 同一个假 key + 付费模型 → `Invalid credential` ⇒ 密钥验证确实存在,只是在最后
 *
 * 把它写成可执行的代码而不是文档段落,是因为「顺序」这种知识写在散文里
 * 无法被检验 —— 而这里它必须让脚本跑绿,等于一条可执行的断言。
 */
type FakeBehavior = {
  /** 改这个可以模拟「上游行为变了」。 */
  readonly freeTierStatus?: number;
  readonly freeTierType?: string;
  /** 401 上故意用 text/plain 发 JSON —— 上游的真实 bug。 */
  readonly authContentType?: string;
  /** 免费模型的响应是否随请求体变化(真实上游**不**变化)。 */
  readonly bodySensitive?: boolean;
  /** 不存在的模型返回什么类型。 */
  readonly ghostType?: string;
};

const CATALOG = ["paid-model-a", "big-pickle", "x-free"];

function isFree(id: string): boolean {
  return id.endsWith("-free") || id === "big-pickle";
}

function syntaxOk(key: string): boolean {
  // 实测:`public` 与 `oc_sk_*` 都通得过语法检查,`bogus` 不行。
  return key === "public" || key.startsWith("oc_sk_");
}

function makeFake(behavior: FakeBehavior = {}): Server {
  const authCt = behavior.authContentType ?? "text/plain;charset=UTF-8";

  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const send = (status: number, ct: string, payload: unknown) => {
        res.writeHead(status, { "content-type": ct });
        res.end(JSON.stringify(payload));
      };
      const err = (type: string, message: string) => ({ type: "error", error: { type, message } });

      if (req.url === "/models") {
        send(200, "application/json", {
          object: "list",
          data: CATALOG.map((id) => ({ id, object: "model", created: 1, owned_by: "fake" })),
        });
        return;
      }

      const auth = req.headers["authorization"];
      const key = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
      let model = "";
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
      } catch {
        /* 畸形体:model 留空,会落进「不存在」分支 —— 与真实上游一致 */
      }

      // ① 存在性
      if (!CATALOG.includes(model)) {
        send(401, authCt, err(behavior.ghostType ?? "ModelError", `Model ${model} is not supported`));
        return;
      }
      // ② key 语法
      if (auth !== undefined && !syntaxOk(key)) {
        send(401, authCt, err("AuthError", "Invalid API key."));
        return;
      }
      // ③ 免费额度闸门 —— 在密钥验证之前
      if (isFree(model)) {
        const prefix = auth === undefined ? "Error from provider (Console): " : "";
        const suffix = behavior.bodySensitive ? ` [len=${body.length}]` : "";
        send(
          behavior.freeTierStatus ?? 403,
          "application/json",
          err(
            behavior.freeTierType ?? "FreeTierError",
            `${prefix}OpenCode's free tier can only be used from within OpenCode${suffix}`,
          ),
        );
        return;
      }
      // ④ 付费模型才走到密钥验证
      if (auth === undefined) {
        send(401, authCt, err("AuthError", "Missing API key."));
        return;
      }
      send(401, "application/json", {
        error: { type: "server_error", message: "Upstream request failed: Invalid credential" },
      });
    });
  });
}

async function runDiscover(behavior: FakeBehavior = {}): Promise<{ code: number; out: string }> {
  const fake = makeFake(behavior);
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const addr = fake.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(PROJECT, "scripts", "discover-upstream.mjs")],
      {
        env: {
          ...process.env,
          ZG_DISCOVER_BASE: `http://127.0.0.1:${addr.port}`,
          // 不带 key —— 免 key 探针就足以驱动全部闸门分支。
          ZG_DISCOVER_KEY: "",
        },
      },
    );
    return { code: 0, out: stdout };
  } catch (e) {
    const e2 = e as { code?: number; stdout?: string };
    return { code: e2.code ?? -1, out: e2.stdout ?? "" };
  } finally {
    fake.close();
    await once(fake, "close");
  }
}

async function runDiscoverWithBase(base: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(PROJECT, "scripts", "discover-upstream.mjs")],
      { env: { ...process.env, ZG_DISCOVER_BASE: base, ZG_DISCOVER_KEY: "" } },
    );
    return { code: 0, out: stdout };
  } catch (e) {
    const e2 = e as { code?: number; stdout?: string };
    return { code: e2.code ?? -1, out: e2.stdout ?? "" };
  }
}

describe("discover-upstream.mjs 自身是一道关卡,必须真的会失败", () => {
  it("行为符合记录时退出 0", async () => {
    const { code, out } = await runDiscover();
    expect(out).toContain("全部期望成立");
    expect(code).toBe(0);
  });

  it("脱敏 ZG_DISCOVER_BASE 中的 userinfo", async () => {
    const { code, out } = await runDiscoverWithBase("http://user:private-token-not-real@127.0.0.1:1");
    expect(code).toBe(1);
    expect(out).toContain("baseUrl: http://127.0.0.1:1");
    expect(out).not.toContain("private-token-not-real");
    expect(out).not.toContain("user:");
  });

  it("免费闸门放开(403 → 200)时退出 1 —— 这是最该被监测到的变化", async () => {
    /*
     * 这条变化的意义最大:若上游重新开放免费额度,`匿名 Worker` 那条被砍掉的
     * 能力就值得重新评估。脚本必须能报出来,否则我们会一直以为闸门还在。
     */
    const { code, out } = await runDiscover({ freeTierStatus: 200 });
    expect(code).toBe(1);
    expect(out).toContain("上游行为已变");
    expect(out).toContain("期望 403");
  });

  it("闸门开始校验请求体时退出 1 —— 那意味着字段级发现重新可做", async () => {
    /*
     * `bodySensitive` 让响应随请求体长度变化,于是「畸形体与合法体逐字节相同」
     * 这条期望不再成立。它一旦变红,就说明字段级发现
     * (逐字段定位被拒原因)重新可行 —— 这是本项目最想知道的上游变化之一。
     */
    const { code, out } = await runDiscover({ bodySensitive: true });
    expect(code).toBe(1);
    expect(out).toContain("逐字节相同");
  });

  it("401 改用正确的 content-type 时退出 1", async () => {
    // 上游把这个 bug 修了也是一种「行为变了」,该被记录而不是静默通过。
    const { code } = await runDiscover({ authContentType: "application/json" });
    expect(code).toBe(1);
  });

  it("不存在的模型改报 AuthError 时退出 1", async () => {
    /*
     * 这条守的是一个真实风险:上游把 401 同时用于「鉴权失败」与「模型不存在」,
     * 而 `classifyStatus` 把 401 归 `auth` → `shouldCooldown` 为真。
     * 若带 key 的路径哪天也这么返回,一个拼错的模型名就会把健康 Worker
     * 逐个打进冷却。见 docs/upstream-quirks.md §4。
     */
    const { code } = await runDiscover({ ghostType: "AuthError" });
    expect(code).toBe(1);
  });
});

/* ================================================================== *
 * package.json 的 script 条目必须指向真实文件
 * ================================================================== */

describe("package.json 的 script 不得指向不存在的文件", () => {
  it("每个 node scripts/*.mjs 条目的目标都存在", async () => {
    /*
     * package.json 条目**与脚本文件一起添加**,不预先挂空条目 ——
     * 指向不存在文件的 script 是清单里的假话,运行时只会得到一句
     * `Cannot find module`。新增脚本时最容易先挂条目后写文件,
     * 约定本身挡不住,所以要有守卫。
     */
    const pkg = JSON.parse(await readFile(join(PROJECT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    const missing: string[] = [];
    let checked = 0;
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const match of cmd.matchAll(/(?:^|\s)(scripts\/[\w.-]+\.mjs)/g)) {
        checked += 1;
        if (!existsSync(join(PROJECT, match[1]!))) missing.push(`${name} → ${match[1]}`);
      }
    }

    // 断言确实检查到了东西 —— 否则正则写错会让这条测试永远绿。
    expect(checked).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("discover:upstream 条目存在且不进 validate(它需要网络)", async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["discover:upstream"]).toBe("node scripts/discover-upstream.mjs");
    // 上游抖动不该让本地关卡变红。
    expect(pkg.scripts["validate"]).not.toContain("discover");
    expect(pkg.scripts["test"]).not.toContain("discover");
  });
});

/* ================================================================== *
 * 怪癖 §6:错误响应的 content-type 必须原样透传
 * ================================================================== */

let upstream: Server;
let upstreamPort: number;
let egress: EgressService;

const TOKEN = "quirks-test-token-not-real";

beforeEach(async () => {
  egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });
});

afterEach(async () => {
  await egress.close();
  if (upstream !== undefined && upstream.listening) {
    upstream.close();
    await once(upstream, "close");
  }
});

async function startUpstream(handler: Parameters<typeof createServer>[1]): Promise<void> {
  upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
  upstreamPort = addr.port;
}

function cfg(): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: { relayToken: TOKEN, baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
    workers: [
      {
        id: "w1",
        name: "",
        kind: "authenticated",
        apiKey: "fake-key-not-real-1",
        enabled: true,
        proxyId: null,
      },
    ],
  });
}

describe("上游错误响应的 content-type 原样透传(怪癖 §6)", () => {
  it("401 的 text/plain 被原样保留 —— 即便体其实是 JSON", async () => {
    /*
     * 实测:Zen 在 401 上用 `text/plain;charset=UTF-8` 发送 **JSON 体**,
     * 而 403 用正确的 `application/json`。两者都直连复现过,是上游行为。
     *
     * **原样透传是正确处置**:我们不替上游纠错,否则用户永远不知道上游到底
     * 发了什么,而"只有某些错误码解析不了"这种症状极难归因 —— 若网关顺手把
     * content-type 改成 application/json,这个上游 bug 就被我们藏起来了,
     * 排查的人会去怀疑自己的客户端。
     */
    await startUpstream((_req, res) => {
      res.writeHead(401, { "content-type": "text/plain;charset=UTF-8" });
      res.end('{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}');
    });

    const res = await createApp({ configOf: cfg, egress, log: () => {} }).request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      },
    );

    expect(res.status).toBe(401);
    // 网关既不纠正也不覆盖 —— 上游说什么就是什么。
    expect(res.headers.get("content-type")).toBe("text/plain;charset=UTF-8");
    // 体仍是可解析的 JSON,这正是上游那个不一致的形态。
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "AuthError", message: "Invalid API key." },
    });
  });

  it("403 的 application/json 同样原样保留(同一上游,两种 content-type)", async () => {
    await startUpstream((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"FreeTierError","message":"free tier only"}}');
    });

    const res = await createApp({ configOf: cfg, egress, log: () => {} }).request(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", messages: [] }),
      },
    );

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
