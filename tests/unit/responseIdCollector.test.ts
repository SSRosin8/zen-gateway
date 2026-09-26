import { describe, expect, it } from "vitest";
import { createResponseIdCollector, MAX_RESPONSE_ID_BYTES } from "../../src/server/routes/relay.ts";
import { responsesSurface } from "../../src/core/protocols/responses.ts";

/**
 * 输出 id 扫描器的预算按**行**计,而不是按块。
 *
 * 集成测试经真实 HTTP 传输,分块位置由内核决定,无法稳定构造
 * 「超长行与 completed 事件在同一块」—— 那正是先前整块丢弃会漏掉 id 的形态。
 */
const collector = () => createResponseIdCollector((p) => responsesSurface.responseIdFrom!(p));
const longText = "x".repeat(MAX_RESPONSE_ID_BYTES + 10);

describe("createResponseIdCollector", () => {
  it("同一块里超长的行只丢它自己,其后的 completed 事件照常取到 id", () => {
    const c = collector();
    c.feed(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: longText })}\n\n` +
        'data: {"type":"response.completed","response":{"id":"resp_same_chunk_not_real"}}\n\n',
    );
    expect(c.value()).toBe("resp_same_chunk_not_real");
  });

  it("超长行跨多块到达时,丢到下一个换行为止,之后恢复", () => {
    const c = collector();
    c.feed(`data: {"delta":"${longText.slice(0, 1000)}`);
    c.feed(longText);
    c.feed(`"}\n\ndata: {"response":{"id":"resp_after_split_not_real"}}\n\n`);
    expect(c.value()).toBe("resp_after_split_not_real");
  });

  it("被丢弃的超长行的剩余部分不会被当作一行新事件解析", () => {
    const c = collector();
    // 行首被丢掉之后,同一行的后半截即便形如 `data: {...}` 也只是正文的一部分。
    c.feed(`data: {"delta":"${longText}`);
    c.feed(` data: {"id":"resp_fragment_not_real"}\n`);
    expect(c.value()).toBeNull();
  });

  it("非流式大体:id 在开头时取得到,不在开头时放弃", () => {
    const early = collector();
    const earlyBody = JSON.stringify({ id: "resp_early_not_real", output: longText });
    early.feed(earlyBody.slice(0, 5000));
    early.feed(earlyBody.slice(5000));
    expect(early.value()).toBe("resp_early_not_real");

    const late = collector();
    late.feed(JSON.stringify({ output: longText, id: "resp_late_not_real" }));
    expect(late.value()).toBeNull();
  });

  it("非流式小体照常整体解析,id 不必在开头", () => {
    const c = collector();
    c.feed(JSON.stringify({ object: "response", id: "resp_small_not_real" }));
    expect(c.value()).toBe("resp_small_not_real");
  });
});
