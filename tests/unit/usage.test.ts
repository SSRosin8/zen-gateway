import { describe, expect, it } from "vitest";
import {
  createUsageCollector,
  describeUsage,
  mergeUsage,
  readUsage,
  type TokenUsage,
} from "../../src/core/models/usage.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { responsesSurface } from "../../src/core/protocols/responses.ts";
import { messagesSurface } from "../../src/core/protocols/messages.ts";

/**
 * token 用量解析。
 *
 * 本文件最要紧的一组断言是**「没报用量」与「用了 0 个」必须区分开** ——
 * 返回全零对象会让 Phase 7 的 usage 覆盖率永远是 100%,而那个指标存在的
 * 意义正是发现没覆盖到的面。
 */

describe("readUsage —— 字段名归一化", () => {
  it("OpenAI 命名", () => {
    expect(readUsage({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 0,
    });
  });

  it("Responses/Anthropic 命名(input/output)同样认", () => {
    /*
     * 两套命名指同一件事,而免费额度闸门让我**无法实测** Zen 在每个面上
     * 用哪套(请求根本到不了模型)。宽着读的代价是多认几个键,
     * 收紧的代价是静默丢掉真实用量。
     */
    const u = readUsage({ input_tokens: 812, output_tokens: 37 });
    expect(u?.promptTokens).toBe(812);
    expect(u?.completionTokens).toBe(37);
  });

  it("上游不报 total 时自己算 —— Anthropic 面就不报", () => {
    expect(readUsage({ input_tokens: 812, output_tokens: 37 })?.totalTokens).toBe(849);
  });

  it("上游报的 total 比分项和大时,取上游的", () => {
    // 有些上游把缓存 token 也计进 total,那个数字比我们能算出的更权威。
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 900 })?.totalTokens)
      .toBe(900);
  });

  it("两套命名同时出现时取大,而不是取先写的那个", () => {
    /*
     * 这条钉住的是 `Math.max` 而不是 `??`。用 `??` 时结果取决于我写的顺序,
     * 而更糟的是它遇到**显式的 0** 会停下 —— 下一条测的正是那个形态。
     */
    const u = readUsage({ prompt_tokens: 3, input_tokens: 812 });
    expect(u?.promptTokens).toBe(812);
  });

  it("显式的 0 不会掩盖另一套命名的真实值", () => {
    /*
     * `{prompt_tokens: 0, input_tokens: 812}` 用 `??` 会读成 **0**
     * (0 不是 nullish),于是一次真实的 812 token 调用被记成零。
     * 这是 `??` 与 `Math.max` 唯一行为不同的形态,所以单独钉一条。
     */
    const u = readUsage({ prompt_tokens: 0, input_tokens: 812 });
    expect(u?.promptTokens).toBe(812);
  });

  it("缓存字段的多种命名都认", () => {
    expect(readUsage({ input_tokens: 1, cache_read_input_tokens: 700 })?.cacheReadTokens).toBe(700);
    expect(readUsage({ prompt_tokens: 1, prompt_cache_hit_tokens: 600 })?.cacheReadTokens).toBe(600);
    expect(
      readUsage({ prompt_tokens: 1, prompt_tokens_details: { cached_tokens: 500 } })?.cacheReadTokens,
    ).toBe(500);
    expect(
      readUsage({ input_tokens: 1, cache_creation_input_tokens: 400 })?.cacheWriteTokens,
    ).toBe(400);
  });

  it("cacheMiss 只在上游**显式报了**时才记,不由减法推算", () => {
    /*
     * `prompt - cacheRead` 在有缓存写入时不成立,推算出来的数字会是错的,
     * 而错的统计比没有统计更糟(它看起来有据可依)。
     */
    expect(readUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 300 })?.cacheMissTokens).toBe(0);
    expect(readUsage({ prompt_tokens: 1000, prompt_cache_miss_tokens: 700 })?.cacheMissTokens).toBe(700);
  });

  it.each([
    ["缺 usage 内容", {}],
    ["全是 0", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ["null", null],
    ["数组", [1, 2]],
    ["字符串", "usage"],
    ["数字", 42],
    ["undefined", undefined],
  ])("拿不到用量时返回 null（%s）", (_label, input) => {
    // 「没报用量」与「用了 0 个 token」必须区分开 —— 见文件头。
    expect(readUsage(input)).toBeNull();
  });

  it("负数与非有限值当作 0,不污染统计", () => {
    expect(readUsage({ prompt_tokens: -5 })).toBeNull();
    expect(readUsage({ prompt_tokens: Number.NaN })).toBeNull();
    expect(readUsage({ prompt_tokens: Number.POSITIVE_INFINITY })).toBeNull();
    // 有一个合法值时,非法的那个不该把它带坏。
    expect(readUsage({ prompt_tokens: -5, completion_tokens: 7 })?.completionTokens).toBe(7);
  });

  it("小数向下取整", () => {
    expect(readUsage({ prompt_tokens: 12.9 })?.promptTokens).toBe(12);
  });

  it("数字字符串认,布尔**不**认", () => {
    /*
     * 朴素写法 `typeof v === "number" ? v : Number(v)` 下,
     * `true` 被 `Number()` 变成 1 —— 一个布尔字段被算成 1 个 token。
     * 数字字符串要认:上游若哪天改成字符串,强行丢弃会让统计静默归零。
     */
    expect(readUsage({ prompt_tokens: "123" })?.promptTokens).toBe(123);
    expect(readUsage({ prompt_tokens: true })).toBeNull();
    expect(readUsage({ prompt_tokens: "" })).toBeNull();
    expect(readUsage({ prompt_tokens: "abc" })).toBeNull();
  });
});

describe("mergeUsage", () => {
  const u = (p: number, c: number): TokenUsage => ({
    promptTokens: p,
    completionTokens: c,
    totalTokens: p + c,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
  });

  it("null 侧直接返回另一侧", () => {
    expect(mergeUsage(null, u(1, 2))).toEqual(u(1, 2));
    expect(mergeUsage(u(1, 2), null)).toEqual(u(1, 2));
    expect(mergeUsage(null, null)).toBeNull();
  });

  it("逐字段取大", () => {
    const merged = mergeUsage(u(800, 0), u(0, 40));
    expect(merged?.promptTokens).toBe(800);
    expect(merged?.completionTokens).toBe(40);
  });

  it("total **重算**而不是取大 —— 否则 Anthropic 面的总数永远偏小", () => {
    /*
     * 这是本组最要紧的一条。Anthropic 的用量拆在两个事件里:
     * `message_start` 只有 input(我们据此推出 total=812),
     * `message_delta` 只有 output(推出 total=37)。
     *
     * 若 total 也取大,结果是 812 —— 而真实总数是 849。
     * 症状是统计里的总 token 数**系统性偏小**,且只在 Messages 面上偏。
     */
    const merged = mergeUsage(u(812, 0), u(0, 37));
    expect(merged?.totalTokens).toBe(849);
  });
});

describe("各面的 usage 信封", () => {
  const USAGE = { input_tokens: 100, output_tokens: 20 };

  it("chat:顶层 usage", () => {
    expect(chatSurface.parseUsage({ usage: USAGE })?.promptTokens).toBe(100);
  });

  it("responses:顶层与 response.usage 都认", () => {
    expect(responsesSurface.parseUsage({ usage: USAGE })?.promptTokens).toBe(100);
    // 流式的 response.completed 事件把整个 response 包了一层。
    expect(responsesSurface.parseUsage({ response: { usage: USAGE } })?.promptTokens).toBe(100);
  });

  it("messages:顶层与 message.usage 都认", () => {
    // message_delta 带 output;message_start 把 usage 放在 message 里。
    expect(messagesSurface.parseUsage({ usage: USAGE })?.promptTokens).toBe(100);
    expect(messagesSurface.parseUsage({ message: { usage: USAGE } })?.promptTokens).toBe(100);
  });

  it("**嵌套信封不互认** —— 接错面会被发现", () => {
    /*
     * 这组是"面接错了"这类接线错误的唯一探测手段。
     *
     * 要说清它测不到什么:三个面都认**顶层** usage,而那**不只是非流式响应的
     * 形状** —— chat 的流式末帧与 messages 的 `message_delta` 也是顶层 usage。
     * 所以"能查出的只有流式事件"这个说法是错的(我先前这么写过):
     * 真正的判据是**嵌套与否**,而七个真实形态里只有两个是嵌套的。
     *
     * 完整矩阵与后果分析在 `usage.ts` 的文件头。下一条用断言把它钉住。
     */
    expect(chatSurface.parseUsage({ response: { usage: USAGE } })).toBeNull();
    expect(chatSurface.parseUsage({ message: { usage: USAGE } })).toBeNull();
    expect(responsesSurface.parseUsage({ message: { usage: USAGE } })).toBeNull();
    expect(messagesSurface.parseUsage({ response: { usage: USAGE } })).toBeNull();
  });

  it("信封矩阵:七个真实形态里**恰好两个**可区分 —— 这个局限本身要被钉住", () => {
    /*
     * `usage.ts` 文件头声称"5/7 不可区分,只有 2 个嵌套形态可区分"。
     * 那是一句关于**本模块能力边界**的声称,而声称就该有断言 ——
     * 否则它与被它取代的那句错话一样不可依赖(纪律 #7 的注释版)。
     *
     * 这条同时是一道回归守卫:若哪天有人"顺手"让 chat 也认 `response.usage`
     * (让接错面更难被发现),可区分数会从 2 掉到 1,这条会红。
     */
    const forms: Array<[string, unknown]> = [
      ["chat 非流式/流式末帧", { usage: USAGE }],
      ["responses 非流式", { usage: USAGE }],
      ["responses 流式 response.usage", { response: { usage: USAGE } }],
      ["messages 非流式", { usage: USAGE }],
      ["messages message_start", { message: { usage: USAGE } }],
      ["messages message_delta", { usage: USAGE }],
    ];
    const faces = [chatSurface, responsesSurface, messagesSurface];

    const distinguishable = forms.filter(
      ([, payload]) => faces.filter((s) => s.parseUsage(payload) !== null).length < 3,
    );

    // 只有两个**嵌套**形态可区分（responses 的 response.usage、messages 的 message.usage）。
    expect(distinguishable.map(([label]) => label)).toEqual([
      "responses 流式 response.usage",
      "messages message_start",
    ]);
  });

  it.each([
    ["chat", chatSurface],
    ["responses", responsesSurface],
    ["messages", messagesSurface],
  ])("%s 面对非对象载荷返回 null 而不抛", (_label, surface) => {
    for (const bad of [null, undefined, 42, "x", [], { usage: null }]) {
      expect(() => surface.parseUsage(bad)).not.toThrow();
      expect(surface.parseUsage(bad)).toBeNull();
    }
  });
});

describe("createUsageCollector —— 流式增量收集", () => {
  const chat = () => createUsageCollector((p) => chatSurface.parseUsage(p));
  const messages = () => createUsageCollector((p) => messagesSurface.parseUsage(p));

  it("非流式:整个 JSON 响应体", () => {
    const c = chat();
    c.feed(JSON.stringify({ id: "x", usage: { prompt_tokens: 9, completion_tokens: 3 } }));
    expect(c.usage()).toMatchObject({ promptTokens: 9, completionTokens: 3 });
  });

  it("非流式且体被**分块**喂入", () => {
    // 累积副本必须跨块拼接 —— 一个 JSON 对象被切成两半仍要能解析。
    const body = JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const c = chat();
    c.feed(body.slice(0, 10));
    c.feed(body.slice(10));
    expect(c.usage()?.promptTokens).toBe(9);
  });

  it("SSE:末帧带 usage", () => {
    const c = chat();
    c.feed('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    c.feed('data: {"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n');
    c.feed("data: [DONE]\n\n");
    expect(c.usage()).toMatchObject({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
  });

  it("SSE 末帧**没有结尾换行**时也能读到", () => {
    /*
     * SSE 的最后一帧常常没有结尾换行。若只在遇到 `\n` 时才解析,
     * 那一帧永远留在 pending 里 —— 而它恰好是 OpenAI 系列**唯一**带 usage 的帧。
     * 症状是"非流式有统计、流式没有"。
     */
    const c = chat();
    c.feed('data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}');
    expect(c.usage()?.promptTokens).toBe(7);
  });

  it("Anthropic:用量**拆在两个事件**里,两端都要收到", () => {
    /*
     * 本文件最要紧的一条。`message_start` 在流的**开头**带 input_tokens,
     * `message_delta` 在**末尾**带 output_tokens。
     *
     * 所以"只留尾部窗口"会丢掉 input(那样就得为此写第二个解析器),
     * 而"只扫开头预算"会丢掉 output(那正是 tap.ts 的扫描预算的做法)。
     * 增量逐事件解析 + 逐字段取大同时覆盖两端。
     */
    const c = messages();
    c.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":812,"output_tokens":1}}}\n\n');
    // 中间塞很多 delta —— 模拟真实长流,确保两端相距很远。
    for (let i = 0; i < 500; i += 1) {
      c.feed(`data: {"type":"content_block_delta","delta":{"text":"块${i}"}}\n\n`);
    }
    c.feed('data: {"type":"message_delta","usage":{"output_tokens":37}}\n\n');

    const u = c.usage();
    expect(u?.promptTokens).toBe(812);
    expect(u?.completionTokens).toBe(37);
    // total 重算,不是两个半数取大。
    expect(u?.totalTokens).toBe(849);
  });

  it("事件跨块切断时仍能拼回来", () => {
    // SSE 分块与事件边界无关 —— 一个事件可以被切在任意位置。
    const c = chat();
    c.feed('data: {"usage":{"prompt_t');
    c.feed('okens":21,"completion_tokens":6}}\n\n');
    expect(c.usage()?.promptTokens).toBe(21);
  });

  it("多字节字符被切断不影响解析", () => {
    /*
     * 这一层拿到的是**已解码**的文本(tap.ts 用 `{stream:true}` 解码),
     * 所以这里不会看到半个 UTF-8 序列。但中文内容会出现在 delta 里,
     * 钉一条确保它不干扰行切分。
     */
    const c = chat();
    c.feed('data: {"choices":[{"delta":{"content":"推理签名无效"}}]}\n\n');
    c.feed('data: {"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
    expect(c.usage()?.promptTokens).toBe(5);
  });

  it("没有任何用量时返回 null,不是全零对象", () => {
    const c = chat();
    c.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    c.feed("data: [DONE]\n\n");
    expect(c.usage()).toBeNull();
  });

  it("解析不了的事件被跳过,不影响其他事件", () => {
    const c = chat();
    c.feed("data: {这不是合法 JSON,但它含 usage 字样}\n\n");
    c.feed('data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n');
    expect(c.usage()?.promptTokens).toBe(8);
  });

  it("[DONE] 与空 data 行不参与解析", () => {
    const c = chat();
    c.feed("data: [DONE]\n\ndata: \n\n");
    expect(c.usage()).toBeNull();
  });

  it("非 data: 行被忽略(event:/id:/注释)", () => {
    const c = chat();
    c.feed("event: message_delta\nid: 1\n: 这是注释\n");
    c.feed('data: {"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n');
    expect(c.usage()?.promptTokens).toBe(4);
  });

  it("一条巨长的无换行流被丢掉,**且后续无换行的事件仍能读到**", () => {
    /*
     * ## 这条测试第一版是空壳,第六轮变异验证查出来的
     *
     * 我原先的第二次 feed **以 `\n` 开头**:
     *
     * ```
     * c.feed(`data: {"usage":${"x".repeat(600 * 1024)}`);
     * c.feed('\ndata: {"usage":{...}}\n\n');   ← 这个前导换行
     * ```
     *
     * 那个换行让超长行被 `indexOf("\n")` 正常切分掉、`pending` 照常清空 ——
     * **有没有丢弃逻辑结果完全一样**。实测:删掉 `if (pending.length >
     * MAX_LINE_LENGTH) pending = ""` 之后这条依然全绿。归类是纪律 #1 的
     * 第二类「条件被另一层顺带满足」。
     *
     * 修法是去掉那个前导换行:此时唯一能让 `pending` 清空的就只有丢弃逻辑,
     * 而若不清空,后面那个事件会被拖在一个永远解析不出来的巨串里。
     *
     * 仍然是纯行为断言,没有内存阈值要猜。
     */
    const c = chat();
    // 1.5 MiB 无换行 —— 超过 MAX_LINE_LENGTH(现为 1 MiB,与 MAX_BUFFERED_BYTES 同)。
    c.feed(`data: {"usage":${"x".repeat(1536 * 1024)}`);
    // **没有**前导换行 —— 只有真的丢弃了,这一条才读得到。
    c.feed('data: {"usage":{"prompt_tokens":6,"completion_tokens":2}}');
    expect(c.usage()?.promptTokens).toBe(6);
  });

  it("我们**自己丢了内容**时 `dropped()` 为真 —— 与「上游没报」分得开", () => {
    /*
     * 「上游没报用量」与「我们把那一行扔了」在外部先前完全无法区分,
     * 两者都表现为 `usage() === null`。而处置完全不同:前者不用改代码,
     * 后者说明界定错了(`MAX_LINE_LENGTH` 就把 Responses 面一条合法的
     * 600 KB `response.completed` 整条弃掉过,且结果取决于上游的分块位置)。
     *
     * 任何常量都可能被越过,所以**越过时可观测**比把常量调大更耐久。
     * 这与 `readUsage` 全零时返回 `null`(而不是全零对象)是同一条理由的延伸。
     */
    const clean = chat();
    clean.feed('data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    expect(clean.usage()).not.toBeNull();
    expect(clean.dropped()).toBe(false);

    const overLine = chat();
    overLine.feed(`data: {"usage":${"x".repeat(1536 * 1024)}`);
    expect(overLine.dropped()).toBe(true);

    const overBuffered = chat();
    overBuffered.feed(`{"padding":"${"y".repeat(2 * 1024 * 1024)}`);
    overBuffered.feed('","usage":{"prompt_tokens":5}}');
    expect(overBuffered.usage()).toBeNull();
    expect(overBuffered.dropped()).toBe(true);
  });

  it("**合法的巨大 `response.completed`** 不再被丢掉 —— 上限与响应体同量级", () => {
    /*
     * 第六轮审核查出的真实缺陷:`MAX_LINE_LENGTH` 先前是 512 KB,而 Responses 面的
     * `response.completed` 事件**内嵌整个 response 对象**(全部输出文本 + usage),
     * 所以那一行的大小 ∝ 生成长度 —— 而它是该面**唯一**带用量的事件。
     *
     * 更糟的是结果**取决于上游的分块位置**:同一条 600 KB 事件,16 KB 逐块喂
     * 时丢失,一次性整条喂时出数(切行循环在检查长度之前就把它切走了)。
     * 那是最难查的一类症状 —— "偶尔不生效,取决于分块位置"。
     */
    const body = (padKB: number): string =>
      `data: {"type":"response.completed","response":{"output":"${"a".repeat(
        padKB * 1024,
      )}","usage":{"input_tokens":1200,"output_tokens":9000}}}\n\n`;

    for (const padKB of [400, 600, 900]) {
      const c = createUsageCollector((p) => responsesSurface.parseUsage(p));
      const ev = body(padKB);
      // 16 KB 逐块 —— 模拟真实分块,这正是先前会丢失的那种喂法。
      for (let i = 0; i < ev.length; i += 16 * 1024) c.feed(ev.slice(i, i + 16 * 1024));
      const u = c.usage();
      expect(u?.promptTokens, `${padKB}KB 的 response.completed 必须出数`).toBe(1200);
      expect(u?.completionTokens).toBe(9000);
      expect(c.dropped()).toBe(false);
    }
  });

  it("非流式累积有上限,超限后不再累积", () => {
    /*
     * 同上:行为断言。超过 1 MiB 的非流式体拿不到用量(截断的 JSON 解析不出来),
     * 但**不抛异常、不影响转发** —— 这才是要保的性质。
     */
    const c = chat();
    c.feed(`{"padding":"${"y".repeat(2 * 1024 * 1024)}`);
    c.feed('","usage":{"prompt_tokens":5}}');
    expect(() => c.usage()).not.toThrow();
    expect(c.usage()).toBeNull();
  });

  it("usage() 可重复调用,结果一致", () => {
    // relay 在 onDone 里只调一次,但幂等让它可以进日志又进统计。
    const c = chat();
    c.feed('data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    expect(c.usage()?.promptTokens).toBe(3);
    expect(c.usage()?.promptTokens).toBe(3);
  });

  it("SSE 用量优先于累积副本 —— 副本可能已被截断", () => {
    /*
     * 两路同时收集(feed 时还不知道这是 SSE 还是单个 JSON)。
     * 一旦见过 `data:` 行就以 SSE 那一路为准:累积副本可能因超限被截断,
     * 而截断的 JSON 解析不出来。
     */
    const c = chat();
    c.feed('data: {"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n');
    expect(c.usage()?.promptTokens).toBe(9);
  });
});

describe("describeUsage", () => {
  it("只输出数字,不含响应内容", () => {
    const line = describeUsage({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      cacheMissTokens: 0,
    });
    expect(line).toBe("in=100 out=20 total=120 cacheRead=80");
  });

  it("为 0 的缓存字段不出现 —— 免得每行日志都拖三个 0", () => {
    const line = describeUsage({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 0,
    });
    expect(line).toBe("in=1 out=2 total=3");
  });
});
