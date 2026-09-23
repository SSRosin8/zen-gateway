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
     * 旧项目那版用 `typeof v === "number" ? v : Number(v)`,于是
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
     * 要说清它测不到什么:三个面都认**顶层** usage(那是各自非流式响应的
     * 形状),所以拿 chat 的非流式载荷喂 responses 会照常出数。能查出的只有
     * 嵌套形态 —— 也就是流式事件。这个局限写在 usage.ts 的文件头里,
     * 因为"每个面只认自己的信封"听起来更漂亮而它是假的。
     */
    expect(chatSurface.parseUsage({ response: { usage: USAGE } })).toBeNull();
    expect(chatSurface.parseUsage({ message: { usage: USAGE } })).toBeNull();
    expect(responsesSurface.parseUsage({ message: { usage: USAGE } })).toBeNull();
    expect(messagesSurface.parseUsage({ response: { usage: USAGE } })).toBeNull();
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
     * 所以"只留尾部窗口"会丢掉 input(旧项目的做法需要为此写第二个解析器),
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

  it("一条巨长的无换行流不会让内存无界增长", () => {
    /*
     * 行为断言而不是内存断言 —— 内存阈值天生要靠猜,而第五轮审核就栽在
     * 一个猜出来的阈值上(输入缩小后恰好落在阈值内,变异后全绿)。
     *
     * 这里测的是**可观察后果**:超长无换行输入被丢弃,所以之后正常的
     * usage 事件仍然能被读到(若 pending 无界增长,它会把后面的内容
     * 拖在一个永远解析不了的巨串里)。
     */
    const c = chat();
    // 600 KB 无换行 —— 超过 MAX_LINE_LENGTH(512 KB)。
    c.feed(`data: {"usage":${"x".repeat(600 * 1024)}`);
    c.feed('\ndata: {"usage":{"prompt_tokens":6,"completion_tokens":2}}\n\n');
    expect(c.usage()?.promptTokens).toBe(6);
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
