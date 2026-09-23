import { describe, expect, it } from "vitest";
import { judgeFree, surfacesFor } from "../../src/core/models/free.ts";
import { upstreamUrl } from "../../src/core/upstream/url.ts";
import { ModelRulesSchema } from "../../src/shared/schema.ts";

/** 出厂默认规则。用 prefault({}) 让内层默认值真的生效（见 schema 的说明）。 */
const defaults = ModelRulesSchema.parse({});

function rules(over: Partial<Parameters<typeof ModelRulesSchema.parse>[0]> = {}) {
  return ModelRulesSchema.parse({ ...over });
}

/** 一份在架目录视图。只需要 ids —— `judgeFree` 不看别的。 */
function catalog(...ids: string[]) {
  return { ids: new Set(ids) };
}

/*
 * 这三条断言在 Phase 6 **刻意改了契约**,不是碰巧变红的。
 *
 * 免费判定从「后缀 ∪ 名单」变成「(后缀 ∪ 名单) ∩ 在架目录」,于是"没有目录
 * 可用"成了一个必须能说出来的第三种结局 —— 它既不是"确定免费"也不是"不免费",
 * 而是"免费依据成立但交集没做"。`reason` 会进诊断输出,把这两种情况都写成
 * `"suffix"` 就让用户无法区分"网关验过了"与"网关没验成"。
 *
 * 按纪律 #3 归类:**断言错**,但属于"外部驱动的刻意契约变更",
 * 与"我写错了断言"是两回事 —— 所以旧断言的意图在下面用带目录的形态保留。
 */
describe("免费模型判定", () => {
  it("带 -free 后缀的放行（有目录佐证）", () => {
    expect(judgeFree("nemotron-3-ultra-free", defaults, catalog("nemotron-3-ultra-free"))).toEqual({
      free: true,
      reason: "suffix",
    });
  });

  it("extraFreeIds 名单里的放行（有目录佐证）", () => {
    // big-pickle 是当日上游目录里唯一的无后缀零费率模型。
    expect(judgeFree("big-pickle", defaults, catalog("big-pickle"))).toEqual({
      free: true,
      reason: "extra",
    });
  });

  it("没有目录时放行,但 reason 标明**未经交集核验**", () => {
    /*
     * 拿不到目录时放行而不是拒绝 —— 两侧代价不对称:
     * 拒绝会让一次上游抖动变成"网关拒绝一切",而放行的唯一后果是
     * 由上游拒绝(实测 400 `Model is unavailable.`),不产生费用。
     *
     * 但 reason 必须不同,否则诊断里看不出这次到底有没有做交集。
     */
    expect(judgeFree("nemotron-3-ultra-free", defaults)).toEqual({
      free: true,
      reason: "suffix_unverified",
    });
    expect(judgeFree("big-pickle", defaults)).toEqual({ free: true, reason: "extra_unverified" });
  });

  it("**已下架**的 -free 模型被拒 —— 这是交集存在的唯一理由", () => {
    /*
     * 规划给 Phase 6 定的门槛原话:「注入一个已下架 id(如 glm-5-free)后,
     * 它被交集自动剔除」。
     *
     * `glm-5-free` 后缀命中,所以 Phase 5 的判定会放行它,然后由上游返回
     * 400 `Upstream request failed: Model is unavailable.` —— 用户看到的是
     * 上游措辞,指不到"这个 id 已经下架了"。实测它确实已不在在架目录里。
     */
    const live = catalog("big-pickle", "nemotron-3-ultra-free");
    expect(judgeFree("glm-5-free", defaults, live)).toEqual({ free: false, reason: "retired" });
    // 同一份目录下,在架的那个照常放行 —— 证明拒绝来自交集而不是别的原因。
    expect(judgeFree("nemotron-3-ultra-free", defaults, live).free).toBe(true);
  });

  it("名单里的 id 下架了同样被拒 —— 交集管两条依据,不只管后缀", () => {
    /*
     * 这条是上一条的反向钉子。若实现只对后缀那一支求交集,
     * 一个用户手写进 extraFreeIds 的过期 id 会永远放行,
     * 而 extraFreeIds 恰恰是**人工维护**的那份 —— 最容易过期。
     */
    const r = rules({ extraFreeIds: ["union-alpha"] });
    expect(judgeFree("union-alpha", r, catalog("big-pickle"))).toEqual({
      free: false,
      reason: "retired",
    });
  });

  it("enforceCatalog 关掉后回到 Phase 5 的行为", () => {
    /*
     * 留这个开关是因为交集依赖能联网拉到目录,而离线或本地假上游环境里拉不到。
     * 关掉的是**交集**,不是免费判定本身。
     *
     * 注意此时即便传了目录也不该求交集 —— 否则这个开关只在"没目录"时有效,
     * 而那正是它最没用的时候。
     */
    const r = rules({ enforceCatalog: false });
    expect(judgeFree("glm-5-free", r, catalog("big-pickle"))).toEqual({
      free: true,
      reason: "suffix",
    });
    expect(judgeFree("big-pickle", r)).toEqual({ free: true, reason: "extra" });
  });

  it("付费模型被拒 —— 即便它在在架目录里", () => {
    /*
     * 交集是**收紧**,不是放宽。一个付费模型当然在在架目录里,
     * 而它必须仍然被拒 —— 否则交集就把免费判定变成了"在架判定",
     * 那是真金白银的代价。
     */
    for (const id of ["claude-opus-5", "gpt-5.5", "kimi-k3", "gemini-3.8-flash"]) {
      expect(judgeFree(id, defaults, catalog(id)).free).toBe(false);
    }
  });

  it("jev-1.13 被拒 —— 无后缀且**不免费**（输入 $0.042/1M，仅输出免费）", () => {
    /*
     * 它与 jev-1.13-free 构成同名前缀的付费/免费对。
     * 若判定做成前缀模糊匹配，这个付费模型会被放行 —— 真金白银的代价。
     *
     * 两个都放进目录,所以此处的差异只可能来自免费判定本身。
     */
    const live = catalog("jev-1.13", "jev-1.13-free");
    expect(judgeFree("jev-1.13", defaults, live).free).toBe(false);
    expect(judgeFree("jev-1.13-free", defaults, live).free).toBe(true);
  });

  it("grok-code 被拒 —— 它只存在于 models.dev，不在上游在架目录里", () => {
    expect(judgeFree("grok-code", defaults).free).toBe(false);
  });

  it("恰好等于后缀本身的 id 被拒", () => {
    // 少了这个条件，一个叫 `-free` 的 id 会被放行。
    expect(judgeFree("-free", defaults, catalog("-free")).free).toBe(false);
  });

  it("后缀出现在中间不算", () => {
    expect(judgeFree("a-free-b", defaults, catalog("a-free-b")).free).toBe(false);
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
    expect(judgeFree("some-new-free-model", r, catalog("some-new-free-model"))).toEqual({
      free: true,
      reason: "extra",
    });
  });

  it("空目录**不**被当成「什么都下架了」", () => {
    /*
     * 这条守的是调用方的错:一份空目录若被当作合法的在架集合,交集会拒掉
     * **一切**模型 —— 网关整体不可用,而症状是"所有模型都说已下架"。
     *
     * 正确的处置在 `catalog.ts`:空 data 的响应**不可采纳**,于是缓存里
     * 永远不会出现空目录,`cached()` 返回 null 而 `judgeFree` 走"未核验"那支。
     * 这里钉住的是那条链的结论 —— 传 null 时必须放行。
     */
    expect(judgeFree("big-pickle", defaults, null).free).toBe(true);
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
