import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createApp } from "../../src/server/app.ts";
import { EgressService } from "../../src/core/proxy/egress.ts";
import { Scheduler } from "../../src/core/routing/scheduler.ts";
import { ProtocolRegistry } from "../../src/core/protocols/registry.ts";
import { readModelField, readStreamField } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";
import { ConfigSchema, type Config } from "../../src/shared/schema.ts";

/**
 * 调度状态机的集成测试 —— 对着**真实 HTTP 假上游**跑,跨多个请求断言状态。
 *
 * 单测已覆盖四块各自的判定;这里验的是**接线**:relay 是否真的把冷却记进了
 * 调度器、粘滞是否跨请求生效、以及不变量 #3 的结算钩子是否真的挂在流末尾。
 *
 * 不变量 #3 尤其只能在这里验:它依赖"SSE 带着 200 把拒绝塞在流里面",
 * 而那个时序 mock 一个 Response 对象表达不出来。
 */

const TOKEN = "scheduling-test-token-x";

/** 长度够格的假推理块(`extractBlobHashes` 要求 ≥16 字符)。 */
const BLOB = "encrypted-reasoning-blob-not-real";

type Req = import("node:http").IncomingMessage;
type Res = import("node:http").ServerResponse;

let upstream: Server;
let upstreamPort: number;
let handler: (req: Req, res: Res) => void;
/** 上游收到的每次请求用的 key —— 用它判断这次由哪个 Worker 承接。 */
let seenKeys: string[];
let egress: EgressService;
/** 注入的时钟,测试自己推进。 */
let now: number;

const START = 1_800_000_000_000;

beforeEach(async () => {
  seenKeys = [];
  now = START;
  handler = (_req, res) => res.end("{}");

  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seenKeys.push(String(req.headers["authorization"] ?? ""));
      handler(req, res);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const addr = upstream.address();
  if (addr === null || typeof addr === "string") throw new Error("无法取得假上游端口");
  upstreamPort = addr.port;

  egress = new EgressService({ timeouts: { headersTimeoutMs: 5_000, bodyTimeoutMs: 5_000 } });
});

afterEach(async () => {
  await egress.close();
  upstream.close();
  await once(upstream, "close");
});

function config(ids: string[]): Config {
  return ConfigSchema.parse({
    version: 1,
    gateway: {
      relayToken: TOKEN,
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    workers: ids.map((id) => ({
      id,
      name: "",
      kind: "authenticated",
      apiKey: `fake-key-${id}-not-real`,
      enabled: true,
      proxyId: null,
    })),
  });
}

/** 抖动固定为 0,让冷却时长可断言。 */
function scheduler(): Scheduler {
  return new Scheduler({ jitter: () => 0 });
}

function app(cfg: Config, sched: Scheduler) {
  return createApp({
    configOf: () => cfg,
    egress,
    scheduler: sched,
    clock: () => now,
    log: () => {},
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** 带一个推理块的请求体。 */
function bodyWithBlob(session?: string): unknown {
  return {
    model: "big-pickle",
    messages: [
      { role: "user", content: "继续" },
      { role: "assistant", reasoning: { encrypted_content: BLOB } },
    ],
    ...(session !== undefined ? {} : {}),
  };
}

/** 从诊断头读出这次由哪个 Worker 承接。 */
function workerOf(res: Response): string | null {
  return res.headers.get("x-zen-gateway-worker");
}

function routeOf(res: Response): string | null {
  return res.headers.get("x-zen-gateway-route");
}

/** 让 w1 吃一个带 Retry-After 的 429,链内转到 w2 成功。 */
function rateLimitFirstKey(): void {
  handler = (req, res) => {
    if (String(req.headers["authorization"]).includes("w1")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end('{"error":"slow down"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  };
}

describe("冷却跨请求生效", () => {
  it("429 之后下一个请求直接跳过该 Worker", async () => {
    /*
     * 这是 Phase 5 之前**完全不存在**的行为:先前 `selectTargets` 每次都按
     * 配置顺序排出全部 Worker,于是每条请求都要先撞一次 w1 的 429 才轮到 w2。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    rateLimitFirstKey();

    const first = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(first.status).toBe(200);
    // 第一条请求撞了 w1 才转到 w2。
    expect(seenKeys).toHaveLength(2);
    expect(workerOf(first)).toBe("w2");

    seenKeys = [];
    now += 1_000;
    const second = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(second.status).toBe(200);
    // 这次一次就中 —— w1 在冷却,根本没进候选。
    expect(seenKeys).toHaveLength(1);
    expect(workerOf(second)).toBe("w2");
  });

  it("尊重 Retry-After:到点前不用,到点后恢复", async () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    rateLimitFirstKey();

    await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));

    // 59 秒:仍在冷却。
    now = START + 59_000;
    expect(s.counts(cfg, now)).toEqual({ ready: 1, total: 2 });

    // 60 秒:恢复。
    now = START + 60_000;
    expect(s.counts(cfg, now)).toEqual({ ready: 2, total: 2 });

    handler = (_req, res) => res.end("{}");
    seenKeys = [];
    const after = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(workerOf(after)).toBe("w1");
  });

  it("全员冷却时只发一次请求,并把上游的真实错误透传", async () => {
    /*
     * 候选只有一个(最早恢复的那个),所以上游只被打一次 —— 而客户端拿到的是
     * 上游真实的 429 负载,不是网关自造的 503。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    handler = (_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "900" });
      res.end('{"error":"上游的原话"}');
    };

    // 第一条把两个都打进冷却(链长 maxAttempts=3,但只有 2 个 Worker)。
    await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(s.counts(cfg, now)).toEqual({ ready: 0, total: 2 });

    seenKeys = [];
    now += 1_000;
    const res = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(seenKeys).toHaveLength(1);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "上游的原话" });
  });
});

describe("不变量 #4:坏请求不拖累 Worker 池", () => {
  it("上游 400 之后所有 Worker 依然就绪", async () => {
    /*
     * 400 是请求本身的问题,不是 Worker 的问题。若据此冷却,一个客户端的
     * 坏请求会把所有健康 Worker 逐个打进冷却 —— 一次拼错的请求体就能让
     * 整个网关瘫痪。
     */
    const cfg = config(["w1", "w2", "w3"]);
    const s = scheduler();
    handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":{"message":"messages must be an array"}}');
    };

    for (let i = 0; i < 5; i += 1) {
      now += 100;
      const res = await app(cfg, s).request(
        "/v1/chat/completions",
        post({ model: "big-pickle", messages: "not-an-array" }),
      );
      expect(res.status).toBe(400);
    }

    expect(s.counts(cfg, now)).toEqual({ ready: 3, total: 3 });
  });

  it("400 不重试 —— 换 Worker 也一样失败", async () => {
    const cfg = config(["w1", "w2", "w3"]);
    handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end("{}");
    };
    await app(cfg, scheduler()).request(
      "/v1/chat/completions",
      post({ model: "big-pickle", messages: [] }),
    );
    expect(seenKeys).toHaveLength(1);
  });
});

describe("会话粘滞跨请求生效", () => {
  it("同一个 x-opencode-session 连续命中同一个 Worker", async () => {
    const cfg = config(["w1", "w2", "w3"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    const session = { "x-opencode-session": "ses_sticky_1" };
    const first = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }, session));
    expect(workerOf(first)).toBe("w1");
    expect(routeOf(first)).toBe("strategy");

    now += 5_000;
    const second = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }, session));
    expect(workerOf(second)).toBe("w1");
    expect(routeOf(second)).toBe("sticky");
  });

  it("不同会话互不影响", async () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    const a = await app(cfg, s).request(
      "/v1/chat/completions",
      post({ model: "big-pickle", messages: [] }, { "x-opencode-session": "ses_a" }),
    );
    const b = await app(cfg, s).request(
      "/v1/chat/completions",
      post({ model: "big-pickle", messages: [] }, { "x-opencode-session": "ses_b" }),
    );
    // 两条都会绑到 w1(它是首选),但各自有独立的绑定条目。
    expect(workerOf(a)).toBe("w1");
    expect(workerOf(b)).toBe("w1");
    expect(s.snapshot(cfg, now).affinity.sessions).toBe(2);
  });

  it("绑定的 Worker 被限流后换人,并改绑到新的", async () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    const session = { "x-opencode-session": "ses_cooldown" };

    handler = (_req, res) => res.end("{}");
    expect(workerOf(await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }, session)))).toBe("w1");

    rateLimitFirstKey();
    now += 1_000;
    const second = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }, session));
    expect(workerOf(second)).toBe("w2");

    // w1 恢复之后这条会话仍留在 w2 —— 严格粘滞不因"原来那个好了"而回迁。
    handler = (_req, res) => res.end("{}");
    now = START + 120_000;
    const third = await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }, session));
    expect(workerOf(third)).toBe("w2");
    expect(routeOf(third)).toBe("sticky");
  });

  it("没有会话头时网关合成的那个不产生粘滞", async () => {
    /*
     * `headers.ts` 在客户端没发时会合成一个 `x-opencode-session`,但那个每
     * 请求都不同,对亲和没有帮助 —— 这种情况下粘滞自然失效,而这是正确的
     * (我们确实无法判断这是不是同一条会话)。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    await app(cfg, s).request("/v1/chat/completions", post({ model: "big-pickle", messages: [] }));
    expect(s.snapshot(cfg, now).affinity.sessions).toBe(0);
  });
});

describe("不变量 #3:流结束后的亲和结算", () => {
  /**
   * 让第一条请求落到 **w2**(而不是配置首位的 w1):先 429 掉 w1。
   * 这样"指纹提示"指向的就是一个**非首选**的 Worker,
   * 后续断言才能区分"提示生效"与"恰好按顺序选中了它"。
   */
  async function learnOnW2(
    cfg: Config,
    s: Scheduler,
    respond: (res: Res) => void,
  ): Promise<Response> {
    handler = (req, res) => {
      if (String(req.headers["authorization"]).includes("w1")) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
        res.end("{}");
        return;
      }
      respond(res);
    };
    return app(cfg, s).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_learn" }),
    );
  }

  it("2xx 流完整读完 → 学习指纹,后续新会话被提示到同一个 Worker", async () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    const first = await learnOnW2(cfg, s, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.end("data: [DONE]\n\n");
    });
    expect(workerOf(first)).toBe("w2");
    // 必须读完 —— 结算发生在流结束之后。
    await first.text();

    // 让 w1 恢复,于是按策略它才是首选。
    now = START + 60_000;
    handler = (_req, res) => res.end("{}");

    const second = await app(cfg, s).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_brand_new" }),
    );
    // 指纹提示赢过策略顺序 —— 否则这里会是 w1。
    expect(workerOf(second)).toBe("w2");
    expect(routeOf(second)).toBe("blob_hint");
  });

  it("SSE 里带着 200 返回「推理已失效」→ 指纹被忘掉", async () => {
    /*
     * 这是不变量 #3 的核心场景,也是 `tap.ts` 存在的全部理由:
     * 上游可以带着 HTTP 200 把这种拒绝塞在流里面。只看状态码会整条漏掉,
     * 于是失效的指纹一直把会话钉在错的 Worker 上 —— 每一轮都失败,
     * 而失败原因看起来来自上游。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    const first = await learnOnW2(cfg, s, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"开头正常"}}]}\n\n');
      res.end('data: {"error":{"message":"reasoning block was not issued to this caller"}}\n\n');
    });
    expect(first.status).toBe(200);
    await first.text();

    now = START + 60_000;
    handler = (_req, res) => res.end("{}");

    const second = await app(cfg, s).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_brand_new" }),
    );
    // 指纹已被忘掉 → 回到策略顺序。
    expect(workerOf(second)).toBe("w1");
    expect(routeOf(second)).toBe("strategy");
    // 该会话的绑定也被解掉了。
    expect(s.snapshot(cfg, now).affinity.blobs).toBe(0);
  });

  it("拒绝消息被切在两个 SSE 块之间时同样检出", async () => {
    /*
     * 跨块扫描的端到端验证。逐块独立匹配会漏,而漏掉的症状取决于上游的
     * 分块位置 —— 时有时无,极难复现。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    const first = await learnOnW2(cfg, s, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"error":{"message":"reasoning block was not iss');
      res.end('ued to this caller"}}\n\n');
    });
    await first.text();

    expect(s.snapshot(cfg, now).affinity.blobs).toBe(0);
  });

  it("上游 400 带失效推理 → 同样解绑(失败路径也要结算)", async () => {
    /*
     * 上游对"回放了别人的推理块"的拒绝正是一个 400。不结算会让下一轮
     * 回到同一个必败 Worker。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    // 先在 w2 上学到指纹。
    const learn = await learnOnW2(cfg, s, (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await learn.text();
    now = START + 60_000;
    expect(s.snapshot(cfg, now).affinity.blobs).toBe(1);

    // 再让它拿到一个带失效推理的 400。
    handler = (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"error":{"message":"invalid signature for reasoning block"}}');
    };
    const rejected = await app(cfg, s).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_learn" }),
    );
    expect(rejected.status).toBe(400);
    await rejected.text();

    expect(s.snapshot(cfg, now).affinity.blobs).toBe(0);
  });

  it("客户端中途取消 → 既不学也不忘", async () => {
    /*
     * 客户端按 ESC 中断生成走这条路,而那与推理是否有效毫无关系。
     * 学了可能把一个其实会拒的 Worker 记成正确答案;忘了则白丢一个
     * 可能正确的绑定。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();

    // 先学到一条指纹。
    const learn = await learnOnW2(cfg, s, (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await learn.text();
    now = START + 60_000;
    expect(s.snapshot(cfg, now).affinity.blobs).toBe(1);

    // 再来一条流,读到一半就取消。
    // 用 holder 对象而不是 `let pending: Res | null`:后者 tsc 会窄化成
    // `never`(闭包里的赋值不进控制流分析),而 Vitest 只转译不检查。
    const held: { res: Res | null } = { res: null };
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"一"}}]}\n\n');
      held.res = res;
    };
    const streamed = await app(cfg, s).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_learn" }),
    );
    const reader = streamed.body!.getReader();
    await reader.read();
    await reader.cancel("客户端走了");
    held.res?.end();

    // 绑定还在 —— 中途取消不该把它清掉。
    expect(s.snapshot(cfg, now).affinity.blobs).toBe(1);
  });

  it("没有推理块的请求不产生任何指纹条目", async () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");
    const res = await app(cfg, s).request(
      "/v1/chat/completions",
      post({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
    );
    await res.text();
    expect(s.snapshot(cfg, now).affinity.blobs).toBe(0);
  });
});

describe("体内会话指针(Phase 6 的 responses 面形态)", () => {
  /**
   * 一个从请求体读会话标识的面 —— 对应 Phase 6 的 `responses`
   * (它的 `previous_response_id` 是标准的服务端会话指针)。
   *
   * 这个假面是必需的,不是图省事:`chatSurface.sessionKeyFrom` 恒返回
   * `undefined`,而它是当前**唯一**注册的面 —— 于是 relay 里
   * 「体内指针优先于头」那条接线**结构上无法失败**。变异测试实测:
   * 把 `bodyKey: surface.sessionKeyFrom(parsed)` 改成 `bodyKey: undefined`
   * 后 53 条测试全绿。
   *
   * 这正是 [[verification-discipline]] 第 1 条的形态:调用点存在不等于
   * 约束成立 —— 要问「这条断言的失败路径是否可达」。
   */
  const responsesLike: ProtocolSurface = {
    id: "responses",
    clientPaths: ["/v1/responses"],
    upstreamPath: "/responses",
    streaming: "optional",
    extractModel: readModelField,
    wantsStream: readStreamField,
    sessionKeyFrom(body: unknown): string | undefined {
      if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
      const value = (body as Record<string, unknown>)["previous_response_id"];
      return typeof value === "string" && value !== "" ? value : undefined;
    },
    extraUpstreamHeaders: () => ({}),
  };

  function appWith(cfg: Config, sched: Scheduler) {
    return createApp({
      configOf: () => cfg,
      egress,
      scheduler: sched,
      registry: new ProtocolRegistry().register(responsesLike),
      clock: () => now,
      log: () => {},
    });
  }

  it("体内指针产生粘滞,即便两次请求的会话头不同", async () => {
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    const body = { model: "big-pickle", previous_response_id: "resp_abc", messages: [] };

    // 两次请求故意带**不同**的 x-opencode-session:若实现只读头,
    // 它们会被当成两条会话,这条断言就红。
    const first = await appWith(cfg, s).request(
      "/v1/responses",
      post(body, { "x-opencode-session": "ses_one" }),
    );
    expect(workerOf(first)).toBe("w1");

    now += 1_000;
    const second = await appWith(cfg, s).request(
      "/v1/responses",
      post(body, { "x-opencode-session": "ses_two" }),
    );
    expect(routeOf(second)).toBe("sticky");
    expect(workerOf(second)).toBe("w1");
    // 只有一条绑定 —— 两次请求归到同一条会话。
    expect(s.snapshot(cfg, now).affinity.sessions).toBe(1);
  });

  it("体内指针**优先于**会话头 —— 它是协议自己的语义", async () => {
    /*
     * 反向验证:同一个头 + 不同的体内指针 → 必须是两条会话。
     * 若实现让头赢,这里只会有一条绑定。
     */
    const cfg = config(["w1", "w2"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    const header = { "x-opencode-session": "ses_same" };
    await appWith(cfg, s).request(
      "/v1/responses",
      post({ model: "big-pickle", previous_response_id: "resp_a", messages: [] }, header),
    );
    await appWith(cfg, s).request(
      "/v1/responses",
      post({ model: "big-pickle", previous_response_id: "resp_b", messages: [] }, header),
    );
    expect(s.snapshot(cfg, now).affinity.sessions).toBe(2);
  });

  it("没有体内指针时退回会话头", async () => {
    const cfg = config(["w1"]);
    const s = scheduler();
    handler = (_req, res) => res.end("{}");

    const header = { "x-opencode-session": "ses_fallback" };
    await appWith(cfg, s).request("/v1/responses", post({ model: "big-pickle", messages: [] }, header));
    now += 1_000;
    const second = await appWith(cfg, s).request(
      "/v1/responses",
      post({ model: "big-pickle", messages: [] }, header),
    );
    expect(routeOf(second)).toBe("sticky");
  });
});

describe("旁路观察不得改变转发内容", () => {
  it("SSE 字节逐字节原样到达客户端", async () => {
    /*
     * 结算钩子挂在流上,所以必须验它没动字节 —— 旁路的全部价值建立在
     * "不改变转发内容"之上。
     */
    const payload =
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
      'data: {"n":1.0}\n\n' +
      "data: [DONE]\n\n";

    const cfg = config(["w1"]);
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload);
    };

    const res = await app(cfg, scheduler()).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_bytes" }),
    );
    // `{"n":1.0}` 必须原样留着 —— JSON 往返会把它变成 `{"n":1}`。
    expect(await res.text()).toBe(payload);
  });

  it("上游先吐字节再断连:仍然不重试(不变量 #1 未被 tap 破坏)", async () => {
    /*
     * 加了旁路之后这条要重验:若 tap 的错误路径被误接成"重试信号",
     * 就会出现"已经发了 200 和一部分 SSE 之后又去重试",客户端收到
     * 两段拼接的响应。
     */
    const cfg = config(["w1", "w2", "w3"]);
    // holder 对象,理由同上一条用例。
    const held: { res: Res | null } = { res: null };
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"部"}}]}\n\n');
      held.res = res;
    };

    const res = await app(cfg, scheduler()).request(
      "/v1/chat/completions",
      post(bodyWithBlob(), { "x-opencode-session": "ses_break" }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read();
    held.res?.destroy();
    await reader.read().catch(() => undefined);

    // 只打了一次上游 —— 头到达之后绝不换 Worker。
    expect(seenKeys).toHaveLength(1);
  });
});
