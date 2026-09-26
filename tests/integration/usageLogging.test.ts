import { describe, expect, it } from "vitest";
import { useSurfaceFixture } from "./helpers/surfaceFixture.ts";

/**
 * 用量解析的集成测试:`parseUsage` 接在真实的转发流上,且用量日志安全、不改字节。
 */

const { up, config, relay, app } = useSurfaceFixture();

describe("用量解析接到了流上(parseUsage 的生产调用点)", () => {
  it("非流式响应的用量被读到,且按面归一化", async () => {
    /*
     * `parseUsage` 若只有接口与实现而没有调用点,就是声明了却不设防的
     * 死字段形态。这条从日志侧验它真的接在流上。
     */
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 123, completion_tokens: 45 } }));
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    // 必须把响应读完 —— 结算钩子挂在流末尾。
    await res.text();

    expect(logs.some((l) => l.includes("in=123 out=45 total=168"))).toBe(true);
  });

  it("**Anthropic 的用量拆在两个 SSE 事件里,两端都要收到**", async () => {
    /*
     * 本组最要紧的一条,也是 Messages 面唯一需要跨事件合并的地方:
     * `message_start` 在流的**开头**带 input_tokens,
     * `message_delta` 在**末尾**带 output_tokens。
     *
     * 所以"只留尾部窗口"会丢输入,"只扫开头预算"会丢输出。
     *
     * 注意这条用 200 个 delta,流只有约 12 KB —— 它**测不到预算边界**
     * (默认 1 MiB)。跨预算那件事由下面两条专门测:12 KB 距 1 MiB
     * 还差两个数量级,在这里塞再多 delta 也执行不到预算那条分支。
     */
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":812,"output_tokens":1}}}\n\n',
      );
      for (let i = 0; i < 200; i += 1) {
        res.write(`data: {"type":"content_block_delta","delta":{"text":"块${i}"}}\n\n`);
      }
      res.end('data: {"type":"message_delta","usage":{"output_tokens":37}}\n\n');
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/messages",
      relay({ model: "big-pickle", max_tokens: 64, stream: true, messages: [] }),
    );
    await res.text();

    // total 是重算的 849,不是两个半数取大的 812。
    expect(logs.some((l) => l.includes("in=812 out=37 total=849"))).toBe(true);
    expect(logs.some((l) => l.includes("messages/big-pickle"))).toBe(true);
  });

  it("**超过 1 MiB 的流**:Messages 面的用量仍然正确 —— 不是 out=1", async () => {
    /*
     * 若 `SCAN_BUDGET_BYTES`(1 MiB)加在 `tapReadable` 的 `onText` 上,而
     * `onText` 有**两个**消费者:失效推理扫描(只需开头)与 token 用量
     * (需要整条流)。两个相反的需求共用一个闸门,牺牲的是后者。
     *
     * Anthropic 面的后果是**算错**而不是漏掉:`message_start` 真的带
     * `output_tokens: 1`(协议形态),超出预算后它成了唯一收到的用量事件,
     * 于是报出 `in=812 out=1 total=813` —— 一个看起来有据可依的错数字。
     * 统计会把它记成一行完整记录,usage 覆盖率显示 100%,
     * 而输出 token 系统性等于 1。
     *
     * 按真实 chunk 尺寸估算约 1 万个输出 token 就跨过 1 MiB,
     * 而长回答恰好是**最值得统计**的那一类请求。
     */
    const logs: string[] = [];
    let streamBytes = 0;
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const head =
        'data: {"type":"message_start","message":{"usage":{"input_tokens":812,"output_tokens":1}}}\n\n';
      res.write(head);
      streamBytes += Buffer.byteLength(head);
      // 纯 ASCII 填充:预算计的是字符数,用 ASCII 才能确定地越过它。
      const filler = `data: {"type":"content_block_delta","delta":{"text":"${"a".repeat(400)}"}}\n\n`;
      for (let i = 0; i < 4000; i += 1) {
        res.write(filler);
        streamBytes += Buffer.byteLength(filler);
      }
      const tail = 'data: {"type":"message_delta","usage":{"output_tokens":37}}\n\n';
      res.end(tail);
      streamBytes += Buffer.byteLength(tail);
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/messages",
      relay({ model: "big-pickle", max_tokens: 64, stream: true, messages: [] }),
    );
    await res.text();

    /*
     * **先钉住输入规模真的越过了预算。**
     *
     * 没有这条断言,这个用例会随 fixture 缩小或预算调大而静默退化成
     * 一条"小流也能出数"的重复测试 —— 而那正是它要替代的那个空壳的成因。
     */
    expect(streamBytes).toBeGreaterThan(1024 * 1024);
    expect(logs.some((l) => l.includes("in=812 out=37 total=849"))).toBe(true);
    // 明确排除那个错数字,而不只是断言正确值存在。
    expect(logs.some((l) => l.includes("out=1 total=813"))).toBe(false);
  });

  it("**超过 1 MiB 的流**:chat 面的末帧用量不会整条丢失", async () => {
    /*
     * 同一个缺陷在 chat/responses 面上的形态是**漏掉**(用量只在末帧,
     * 超预算后 `onText` 完全停掉 → `usage()` 返回 null → 不打日志)。
     * 比 Messages 那条轻(统计偏小而非错误),但同样静默。
     */
    const logs: string[] = [];
    let streamBytes = 0;
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const filler = `data: {"choices":[{"delta":{"content":"${"a".repeat(400)}"}}]}\n\n`;
      for (let i = 0; i < 4000; i += 1) {
        res.write(filler);
        streamBytes += Buffer.byteLength(filler);
      }
      const tail = 'data: {"usage":{"prompt_tokens":900,"completion_tokens":5000}}\n\n';
      res.end(tail);
      streamBytes += Buffer.byteLength(tail);
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );
    await res.text();

    expect(streamBytes).toBeGreaterThan(1024 * 1024);
    expect(logs.some((l) => l.includes("in=900 out=5000 total=5900"))).toBe(true);
  });

  it("用量日志里的 model id 过脱敏 —— 换行不能伪造一条日志行", async () => {
    /*
     * `model` 是客户端可控的任意字符串,不能原样拼进日志格式串。
     * `readModelField` 只保证"非空且无首尾空白",既不限长也不管控制字符 ——
     * 它的职责是取字段,不是净化日志。
     *
     * 实测后果:model 里一个 `\n` 就能让 `data/zen-gateway.log`
     * (append-only 且无轮转)多出一条形态与真实记录**无法区分**的用量行。
     */
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    };

    const evil =
      "x\n用量 chat/victim-model-free: in=999999 out=999999 total=1999998\n#-free";
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: evil, messages: [] }),
    );
    await res.text();

    const line = logs.find((l) => l.startsWith("用量"));
    expect(line).toBeDefined();
    // 整条日志必须仍是**一行**。
    expect(line?.split("\n")).toHaveLength(1);
    // 且不存在一行完全冒充成合法用量记录。
    const forged = (line ?? "")
      .split("\n")
      .some((l) => /^用量 chat\/victim-model-free: in=\d+ out=\d+ total=\d+$/.test(l));
    expect(forged).toBe(false);
  });

  it("用量日志里的 model id 有长度上限 —— 2 MB 的 id 不产出 2 MB 的日志行", async () => {
    /*
     * 同一处的第二个后果:放大比 1.000,而日志文件无轮转。
     * 用行为断言(日志行长度)而不是内存/耗时阈值 —— 阈值天生要靠猜。
     */
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    };

    const huge = `${"y".repeat(2 * 1024 * 1024)}-free`;
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: huge, messages: [] }),
    );
    await res.text();

    const line = logs.find((l) => l.startsWith("用量"));
    expect(line).toBeDefined();
    // 远小于输入;留出格式串与用量数字的余量,但必须是常数级。
    expect(line?.length).toBeLessThan(1024);
  });

  it("Responses 面的流式用量在 `response.usage` 里", async () => {
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"你"}\n\n');
      res.end(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":70,"output_tokens":8}}}\n\n',
      );
    };

    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/responses",
      relay({ model: "big-pickle", stream: true, input: "hi" }),
    );
    await res.text();

    expect(logs.some((l) => l.includes("in=70 out=8 total=78"))).toBe(true);
  });

  it("没有用量时不打日志 —— 免费模型未必报 usage", async () => {
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [] }));
    };
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    await res.text();
    expect(logs.filter((l) => l.startsWith("用量"))).toHaveLength(0);
  });

  it("用量日志**不含响应内容** —— 只有数字", async () => {
    const logs: string[] = [];
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "这段是用户的对话内容不得进日志" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      );
    };
    const res = await app(config(), undefined, (m) => logs.push(m)).request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", messages: [] }),
    );
    await res.text();

    const usageLines = logs.filter((l) => l.startsWith("用量"));
    expect(usageLines).toHaveLength(1);
    expect(usageLines[0]).not.toContain("对话内容");
  });

  it("用量收集**不改变转发字节**", async () => {
    /*
     * 旁路的全部价值建立在"它不改变转发内容"之上。用量收集与失效推理扫描
     * 共用同一个 `onText`,所以多挂一个消费者也不能动字节。
     */
    const payload = 'data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(payload);
    };
    const res = await app().request(
      "/v1/chat/completions",
      relay({ model: "big-pickle", stream: true, messages: [] }),
    );
    expect(await res.text()).toBe(payload);
  });
});
