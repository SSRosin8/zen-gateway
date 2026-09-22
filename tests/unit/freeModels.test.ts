import { describe, expect, it } from "vitest";
import { judgeFree, surfacesFor } from "../../src/core/models/free.ts";
import { upstreamUrl } from "../../src/core/upstream/url.ts";
import { ModelRulesSchema } from "../../src/shared/schema.ts";

/** 出厂默认规则。用 prefault({}) 让内层默认值真的生效（见 schema 的说明）。 */
const defaults = ModelRulesSchema.parse({});

function rules(over: Partial<Parameters<typeof ModelRulesSchema.parse>[0]> = {}) {
  return ModelRulesSchema.parse({ ...over });
}

describe("免费模型判定", () => {
  it("带 -free 后缀的放行", () => {
    expect(judgeFree("nemotron-3-ultra-free", defaults)).toEqual({ free: true, reason: "suffix" });
  });

  it("extraFreeIds 名单里的放行", () => {
    // big-pickle 是当日上游目录里唯一的无后缀零费率模型。
    expect(judgeFree("big-pickle", defaults)).toEqual({ free: true, reason: "extra" });
  });

  it("付费模型被拒", () => {
    for (const id of ["claude-opus-5", "gpt-5.5", "kimi-k3", "gemini-3.8-flash"]) {
      expect(judgeFree(id, defaults).free).toBe(false);
    }
  });

  it("jev-1.13 被拒 —— 无后缀且**不免费**（输入 $0.042/1M，仅输出免费）", () => {
    /*
     * 它与 jev-1.13-free 构成同名前缀的付费/免费对。
     * 若判定做成前缀模糊匹配，这个付费模型会被放行 —— 真金白银的代价。
     */
    expect(judgeFree("jev-1.13", defaults).free).toBe(false);
    expect(judgeFree("jev-1.13-free", defaults).free).toBe(true);
  });

  it("grok-code 被拒 —— 它只存在于 models.dev，不在上游在架目录里", () => {
    expect(judgeFree("grok-code", defaults).free).toBe(false);
  });

  it("恰好等于后缀本身的 id 被拒", () => {
    // 少了这个条件，一个叫 `-free` 的 id 会被放行。
    expect(judgeFree("-free", defaults).free).toBe(false);
  });

  it("后缀出现在中间不算", () => {
    expect(judgeFree("a-free-b", defaults).free).toBe(false);
  });

  it("大小写不等价 —— 判定不做归一化", () => {
    // 归一化会让「网关认为的 id」与「发给上游的 id」产生分歧，那就是放行漏洞。
    expect(judgeFree("BIG-PICKLE", defaults).free).toBe(false);
    expect(judgeFree("NEMOTRON-3-ULTRA-FREE", defaults).free).toBe(false);
  });

  it("空的 extraFreeIds 下仍按后缀放行", () => {
    const r = rules({ extraFreeIds: [] });
    expect(judgeFree("big-pickle", r).free).toBe(false);
    expect(judgeFree("x-free", r).free).toBe(true);
  });

  it("自定义后缀生效 —— 目录变化不该需要改代码", () => {
    const r = rules({ freeSuffix: ":gratis" });
    expect(judgeFree("model:gratis", r).free).toBe(true);
    expect(judgeFree("model-free", r).free).toBe(false);
  });

  it("用户把模型加进 extraFreeIds 后立即放行", () => {
    const r = rules({ extraFreeIds: ["some-new-free-model"] });
    expect(judgeFree("some-new-free-model", r)).toEqual({ free: true, reason: "extra" });
  });
});

describe("协议面覆写", () => {
  it("无覆写时用默认集", () => {
    expect(surfacesFor("x-free", defaults)).toEqual(defaults.defaultSurfaces);
  });

  it("有覆写时用覆写值", () => {
    const r = rules({ surfaceOverrides: { "big-pickle": ["messages"] } });
    expect(surfacesFor("big-pickle", r)).toEqual(["messages"]);
  });

  it("覆写不影响其他模型", () => {
    const r = rules({ surfaceOverrides: { "big-pickle": ["messages"] } });
    expect(surfacesFor("other-free", r)).toEqual(r.defaultSurfaces);
  });
});

describe("上游 URL 拼接", () => {
  it("保留 baseUrl 的路径前缀 —— 这是最容易错的一处", () => {
    /*
     * 朴素写法 new URL("/chat/completions", "https://opencode.ai/zen/v1")
     * 会得到 https://opencode.ai/chat/completions —— /zen/v1 被整段丢掉。
     * 症状是 404，而用户会以为是模型不存在。
     */
    expect(upstreamUrl("https://opencode.ai/zen/v1", "/chat/completions")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });

  it("baseUrl 以 / 结尾时结果相同", () => {
    expect(upstreamUrl("https://opencode.ai/zen/v1/", "/chat/completions")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });

  it("upstreamPath 不带前导 / 时结果相同", () => {
    expect(upstreamUrl("https://opencode.ai/zen/v1", "chat/completions")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });

  it("多个前导 / 被规范化", () => {
    expect(upstreamUrl("https://opencode.ai/zen/v1", "///chat/completions")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });

  it("baseUrl 带 query 时丢弃 query —— 否则拼出永远到不了的地址", () => {
    expect(upstreamUrl("https://h.invalid/v1?token=abc", "/models")).toBe(
      "https://h.invalid/v1/models",
    );
  });

  it("baseUrl 带 fragment 时丢弃", () => {
    expect(upstreamUrl("https://h.invalid/v1#frag", "/models")).toBe("https://h.invalid/v1/models");
  });

  it("根路径 baseUrl 可用", () => {
    expect(upstreamUrl("https://h.invalid", "/models")).toBe("https://h.invalid/models");
  });

  it("保留端口", () => {
    expect(upstreamUrl("http://127.0.0.1:8080/api", "/models")).toBe(
      "http://127.0.0.1:8080/api/models",
    );
  });

  it("多层路径前缀完整保留", () => {
    expect(upstreamUrl("https://h.invalid/a/b/c", "/models")).toBe("https://h.invalid/a/b/c/models");
  });
});
