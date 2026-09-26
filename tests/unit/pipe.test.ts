import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { Response as UndiciResponse } from "undici";
import { pipeUpstreamResponse } from "../../src/core/upstream/pipe.ts";

/**
 * `pipeUpstreamResponse`:上游响应到客户端响应的透传。
 *
 * 它在**上游已经成功之后**被调用,所以这里的每条失败路径都必须既不丢掉
 * 结算通知(`onDone`),也不把一个已成功的上游响应变成 500。
 */
describe("pipe.ts 无 body 的补偿分支", () => {
  /** 造一个 undici 风格的响应。204/304 时 body 为 null,与 undici 实测一致。 */
  function upstreamOf(status: number, body: ReadableStream<Uint8Array> | null): UndiciResponse {
    return {
      status,
      statusText: "",
      headers: new Headers({ "content-type": "application/json" }),
      body,
    } as unknown as UndiciResponse;
  }

  it.each([204, 304])("status %i:onDone 必须被调用一次", (status) => {
    /*
     * 这条分支的注释自己写明了后果(「一次本该学习绑定的成功被静默丢掉,
     * 症状是粘滞偶发失效」),而全仓没有任何测试用 204/304 形态调用过
     * `pipeUpstreamResponse`,更没有配 tap 的 —— 也就是**这个缺陷的修复
     * 没有任何测试守着**,被改回去不会有人知道。
     *
     * 变异验证:删掉整块补偿后测试与 typecheck 都绿。
     */
    let doneCalls = 0;
    let doneError: unknown = "未调用";
    pipeUpstreamResponse(upstreamOf(status, null), {}, {
      onText: () => {},
      onDone: (err) => { doneCalls += 1; doneError = err; },
    });
    expect(doneCalls).toBe(1);
    // 无体响应是"完整"的 —— 结算方靠 null 判断这一点。
    expect(doneError).toBeNull();
  });

  it("body 为 null 但状态码是 200 时同样通知", () => {
    let doneCalls = 0;
    pipeUpstreamResponse(upstreamOf(200, null), {}, {
      onText: () => {},
      onDone: () => { doneCalls += 1; },
    });
    expect(doneCalls).toBe(1);
  });

  it("有 body 时**只**经 tap 通知一次,不叠加补偿", () => {
    // 防的是"既走 tap 又走补偿"——那会让结算跑两遍。
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    let doneCalls = 0;
    const res = pipeUpstreamResponse(upstreamOf(200, body), {}, {
      onText: () => {},
      onDone: () => { doneCalls += 1; },
    });
    // 还没读,所以 tap 尚未触发 —— 关键是补偿没有抢先跑。
    expect(doneCalls).toBe(0);
    expect(res.body).not.toBeNull();
  });
});

describe("statusText 兜底(畸形的是 statusText 而不是头)", () => {
  it("畸形 statusText 时退回不带它的构造,响应仍然产出", () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    const res = pipeUpstreamResponse(
      {
        status: 200,
        // 含 CR/LF 的 statusText 会让标准 Response 构造抛错。
        statusText: "OK\r\nX-Injected: 1",
        headers: new Headers(),
        body,
      } as unknown as UndiciResponse,
      {},
    );
    expect(res.status).toBe(200);
  });
});

describe("pipe 抛错时必须释放它**自己锁住**的流", () => {
  /**
   * 造一个带 body 的上游响应,状态码可控。
   *
   * `status: 600` 让两次 `new Response()` 构造**都**抛 `RangeError`
   * (实测 undici 8.10.2 会原样透传这类状态行并给出 body 流)。
   */
  function upstreamOf(status: number): { res: UndiciResponse; body: ReadableStream<Uint8Array> } {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
    });
    return {
      res: {
        status,
        statusText: "X",
        headers: new Headers({ "content-type": "text/event-stream" }),
        body,
      } as unknown as UndiciResponse,
      body,
    };
  }

  it("状态码越界导致构造失败时,onDone 仍被通知一次且标记为不完整", async () => {
    /*
     * 本文件最要紧的一条。`tapReadable` 内部 `getReader()` 锁住了
     * 上游 body,而 `new Response()` 仍可能抛 —— 此时 `relay.ts` 那层兜底的
     * `upstream.body?.cancel()` 会异步拒绝(流已被锁)并被 `.catch()` 吞掉。
     *
     * 对照实测:
     * ```
     * 无 tap: pipe 抛 RangeError | body.locked=false | cancel → resolved
     * 带 tap: pipe 抛 RangeError | body.locked=true  | cancel → REJECTED
     * ```
     *
     * 三重后果全静默:连接泄漏(上界 = bodyTimeout,5 分钟)、
     * `onDone` 一次都不触发(不变量 #3 整条漏掉)、客户端拿到裸 500。
     *
     * 耐久的结论不是"拦一下 600" —— 而是**谁锁的谁负责释放**。
     * 所以断言的是「pipe 自己完成了处置」,而不是某个状态码被特判。
     */
    const { res } = upstreamOf(600);
    let doneCalls = 0;
    let doneError: unknown = null;

    expect(() =>
      pipeUpstreamResponse(res, {}, {
        onText: () => {},
        onDone: (err) => { doneCalls += 1; doneError = err; },
      }),
    ).toThrow();

    // 取消是异步的,给它一个微任务周期。
    await Promise.resolve();
    await new Promise((r) => { setTimeout(r, 0); });

    expect(doneCalls).toBe(1);
    // 非 null → 结算方按"不完整"处理,既不学习也不遗忘。这是正确的:
    // 客户端根本没收到这个响应。
    expect(doneError).not.toBeNull();
  });

  it("没有 tap 时不代管 body —— 释放责任仍在调用方", () => {
    /*
     * 边界:`pipe` 只释放**自己锁住**的流。没传 tap 时它没锁,
     * 那么 body 仍归调用方处置(`relay.ts` 的兜底能成功 cancel)。
     *
     * 这条防的是"修过头":让 pipe 无条件 cancel 会把一个本可由上层
     * 决定如何处置的 body 提前关掉。
     */
    const { res, body } = upstreamOf(600);
    expect(() => pipeUpstreamResponse(res, {})).toThrow();
    // 没被锁,所以调用方还能释放它。
    expect(body.locked).toBe(false);
  });
});

describe("响应头：content-length 必须剥掉", () => {
  it("上游的 content-length 不转发", () => {
    /*
     * undici 已替我们解压,上游的 content-length 描述的是**压缩前/压缩后**
     * 的字节数,与我们实际转发的字节数不符。转发它会让客户端按错的长度
     * 截断或挂等。
     *
     * 先前从剥离集里删掉 content-length 后测试全绿 ——
     * 既有断言只检查了 content-encoding。
     */
    const upstream = new UndiciResponse("0123456789", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "3" },
    });
    const out = pipeUpstreamResponse(upstream);
    expect(out.headers.get("content-length")).toBeNull();
    // 其余头照常转发。
    expect(out.headers.get("content-type")).toBe("application/json");
  });

  it("真实 gzip 上游：客户端拿到完整明文且不被错的长度误导", async () => {
    // 端到端印证上面那条:压缩响应经网关后,长度信息必须来自实际字节。
    const payload = JSON.stringify({ text: "x".repeat(200) });
    const gz = gzipSync(Buffer.from(payload));

    let server: Server | undefined;
    try {
      server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(gz.byteLength),
          });
          res.end(gz);
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");

      const { fetch: undiciFetch } = await import("undici");
      const upstream = await undiciFetch(`http://127.0.0.1:${addr.port}/x`);
      const out = pipeUpstreamResponse(upstream);

      expect(out.headers.get("content-length")).toBeNull();
      expect(out.headers.get("content-encoding")).toBeNull();
      // 完整明文,不是被 gz 长度截断的片段。
      expect(await out.text()).toBe(payload);
    } finally {
      server?.close();
      if (server) await once(server, "close").catch(() => {});
    }
  });
});

describe("响应透传：上游已成功时绝不因畸形头而 500", () => {
  it("上游给出畸形头时跳过该头，其余照常转发", () => {
    /*
     * `pipeUpstreamResponse` 在**上游已经成功之后**被调用。此时抛异常的后果:
     * 客户端拿裸 500(不是我们的 JSON 错误形状)、上游那次请求已真实计入额度、
     * 响应体既不转发也不释放(连接泄漏)、且日志完全不被调用。
     *
     * 头名/头值都来自上游,不在我们控制内 —— 一个畸形头不该毁掉整个响应。
     */
    const upstream = new UndiciResponse('{"ok":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    // 诊断头里塞入 CRLF（schema 现已挡住这种 worker id，此处验证纵深防御）。
    const out = pipeUpstreamResponse(upstream, {
      "x-zen-gateway-worker": `w1${String.fromCharCode(0x0d, 0x0a)}X-Evil: 1`,
      "x-zen-gateway-attempts": "1",
    });

    expect(out.status).toBe(200);
    // 畸形的那个被跳过，正常的那个仍在。
    expect(out.headers.get("x-zen-gateway-attempts")).toBe("1");
    expect(out.headers.get("x-evil")).toBeNull();
    // 上游内容照常转发。
    expect(out.headers.get("content-type")).toBe("application/json");
  });
});
