import { describe, expect, it } from "vitest";
import { ProtocolRegistry, ProtocolRegistryError } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
import { responsesSurface } from "../../src/core/protocols/responses.ts";
import { ANTHROPIC_VERSION, messagesSurface } from "../../src/core/protocols/messages.ts";
import { buildRegistry } from "../../src/server/app.ts";
import { readModelField, readStreamField, isRecord } from "../../src/core/protocols/types.ts";
import type { ProtocolSurface } from "../../src/core/protocols/types.ts";
import type { ProtocolId } from "../../src/shared/schema.ts";

/** 造一个最小假面,用于驱动注册表的边界。 */
function fakeSurface(id: ProtocolId, paths: string[]): ProtocolSurface {
  return {
    id,
    clientPaths: paths,
    upstreamPath: `/${id}`,
    streaming: "optional",
    extractModel: readModelField,
    wantsStream: readStreamField,
    sessionKeyFrom: () => undefined,
    extraUpstreamHeaders: () => ({}),
    // 假面不报用量 —— 本文件测的是注册表边界,不是用量解析。
    parseUsage: () => null,
  };
}

describe("协议面注册表", () => {
  it("按路径精确查找", () => {
    const r = new ProtocolRegistry().register(chatSurface);
    expect(r.byPath("/v1/chat/completions")?.id).toBe("chat");
    expect(r.byPath("/chat/completions")?.id).toBe("chat");
  });

  it("不做前缀匹配 —— 前缀匹配会让路由不可预测", () => {
    const r = new ProtocolRegistry().register(chatSurface);
    expect(r.byPath("/v1/chat/completions/extra")).toBeNull();
    expect(r.byPath("/v1/chat")).toBeNull();
  });

  it("路径冲突在注册时就抛错,而不是按注册顺序静默裁决", () => {
    /*
     * 两个面抢同一路径时,请求会被先注册者接走,而这在测试里通常看不出来
     * （两个面的最小请求可能都成功,只是其中一个走错了上游路径）。
     * 必须在启动期炸掉。
     */
    const r = new ProtocolRegistry().register(fakeSurface("chat", ["/x"]));
    expect(() => r.register(fakeSurface("responses", ["/x"]))).toThrow(ProtocolRegistryError);
  });

  it("重复注册同一个 id 抛错", () => {
    const r = new ProtocolRegistry().register(fakeSurface("chat", ["/a"]));
    expect(() => r.register(fakeSurface("chat", ["/b"]))).toThrow(ProtocolRegistryError);
  });

  it("没有 clientPaths 的面被拒 —— 那是个永远收不到请求的静默失效注册", () => {
    const r = new ProtocolRegistry();
    expect(() => r.register(fakeSurface("chat", []))).toThrow(/未声明任何 clientPaths/);
  });

  it("路径必须以 / 开头", () => {
    const r = new ProtocolRegistry();
    expect(() => r.register(fakeSurface("chat", ["v1/chat"]))).toThrow(/必须以 \/ 开头/);
  });

  it("冲突注册失败后,注册表不被部分污染", () => {
    // 一个面有多条路径,若第二条冲突,第一条不该已经被写进去。
    const r = new ProtocolRegistry().register(fakeSurface("chat", ["/a"]));
    expect(() => r.register(fakeSurface("responses", ["/b", "/a"]))).toThrow();
    expect(r.byPath("/b")).toBeNull();
    expect(r.get("responses")).toBeNull();
    expect(r.size).toBe(1);
  });

  it("paths() 覆盖所有注册路径,供路由装配", () => {
    const r = new ProtocolRegistry().register(chatSurface);
    expect(r.paths().sort()).toEqual(["/chat/completions", "/v1/chat/completions"]);
  });
});

describe("请求体字段读取", () => {
  it.each([
    ["普通对象", { model: "big-pickle" }, "big-pickle"],
    ["缺 model", {}, null],
    ["model 是数字", { model: 1 }, null],
    ["model 是 null", { model: null }, null],
    ["model 是空串", { model: "" }, null],
    ["model 带首尾空白", { model: " big-pickle " }, null],
    ["model 带尾部换行", { model: "big-pickle\n" }, null],
  ])("%s", (_label, body, expected) => {
    expect(readModelField(body)).toBe(expected);
  });

  it.each([
    ["null", null],
    ["数组", [{ model: "x" }]],
    ["字符串", '{"model":"x"}'],
    ["数字", 42],
    ["undefined", undefined],
  ])("非对象 body（%s）返回 null 而不抛", (_label, body) => {
    // 客户端能发任何形状。抛 TypeError 会把一个 400 变成 500。
    expect(() => readModelField(body)).not.toThrow();
    expect(readModelField(body)).toBeNull();
  });

  it("model 不做大小写归一化 —— 归一化会在判定与转发之间制造分歧", () => {
    // 上游 id 本身是规范小写,客户端发 Big-Pickle 被拒是正确结果。
    expect(readModelField({ model: "Big-Pickle" })).toBe("Big-Pickle");
  });

  it("stream 只认真正的布尔真值", () => {
    expect(readStreamField({ stream: true })).toBe(true);
    // 字符串 "true" 不算 —— 否则 "false" 这个字符串也会是真值。
    expect(readStreamField({ stream: "true" })).toBe(false);
    expect(readStreamField({ stream: 1 })).toBe(false);
    expect(readStreamField({})).toBe(false);
    expect(readStreamField(null)).toBe(false);
  });

  it("isRecord 排除数组与 null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});

describe("chat 面", () => {
  it("同时接受带 /v1 与不带的路径", () => {
    // 客户端 baseUrl 写成 .../v1 还是不带都常见,少一条别名就是一个难查的 404。
    expect(chatSurface.clientPaths).toContain("/v1/chat/completions");
    expect(chatSurface.clientPaths).toContain("/chat/completions");
  });

  it("上游路径不含 /v1 —— 它由 baseUrl 承担", () => {
    expect(chatSurface.upstreamPath).toBe("/chat/completions");
  });

  it("本面没有体内会话标识,亲和只能靠 x-opencode-session", () => {
    expect(chatSurface.sessionKeyFrom({ previous_response_id: "x" })).toBeUndefined();
  });

  it("本面无特有上游头", () => {
    expect(chatSurface.extraUpstreamHeaders({ apiKey: "k", streaming: true })).toEqual({});
  });
});

describe("responses 面", () => {
  it("同时接受带 /v1 与不带的路径", () => {
    expect(responsesSurface.clientPaths).toContain("/v1/responses");
    expect(responsesSurface.clientPaths).toContain("/responses");
  });

  it("上游路径是 /responses", () => {
    expect(responsesSurface.upstreamPath).toBe("/responses");
  });

  it("**读体内会话指针** —— 这是本面唯一的结构性新东西", () => {
    /*
     * `previous_response_id` 是协议**自己**的会话语义,而另两个面都只能靠
     * `x-opencode-session` 头。它让 relay 里「体内指针优先于头」那条接线
     * 第一次真的可执行 —— 在只有 chat 面的时候它**结构上无法执行**
     * (`chatSurface.sessionKeyFrom` 恒返回 undefined 且它是唯一注册的面),
     * 第五轮审核把那种情况归为「调用点存在但输入集为空」。
     */
    expect(responsesSurface.sessionKeyFrom({ previous_response_id: "resp_abc" })).toBe("resp_abc");
  });

  it("`previous_response_id: null` 是「新链」,不是会话键", () => {
    /*
     * 把 null 当成会话键会让**所有新链共享同一个绑定** ——
     * 于是互不相关的会话被绑到同一个 Worker,而粘滞的意义正好相反。
     */
    expect(responsesSurface.sessionKeyFrom({ previous_response_id: null })).toBeUndefined();
    expect(responsesSurface.sessionKeyFrom({ previous_response_id: "" })).toBeUndefined();
    expect(responsesSurface.sessionKeyFrom({})).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["数组", [{ previous_response_id: "x" }]],
    ["字符串", "x"],
    ["数字", 1],
    ["undefined", undefined],
    ["指针是数字", { previous_response_id: 42 }],
  ])("非法体(%s)返回 undefined 而不抛", (_label, body) => {
    expect(() => responsesSurface.sessionKeyFrom(body)).not.toThrow();
    expect(responsesSurface.sessionKeyFrom(body)).toBeUndefined();
  });

  it("两种形态都支持,所以是 optional 而非 sse", () => {
    // 写成 "sse" 会在语义上声称本面只产生 SSE,而它的非流式响应是完整 JSON。
    expect(responsesSurface.streaming).toBe("optional");
  });

  it("无特有上游头", () => {
    expect(responsesSurface.extraUpstreamHeaders({ apiKey: "k", streaming: false })).toEqual({});
  });
});

describe("messages 面", () => {
  it("同时接受带 /v1 与不带的路径", () => {
    expect(messagesSurface.clientPaths).toContain("/v1/messages");
    expect(messagesSurface.clientPaths).toContain("/messages");
  });

  it("上游路径是 /messages", () => {
    expect(messagesSurface.upstreamPath).toBe("/messages");
  });

  it("**把 key 镜像到 x-api-key** —— 少了它整池 Worker 会被冷却", () => {
    /*
     * 这条是 Phase 6 实测出来的最要紧一条,而它先前**没有任何测试守着**
     * (变异 M3:把镜像那行删掉后 45 条用量测试全绿)。
     *
     * 实测(2026-09-23,先免 key 再用真实 key 在**免费模型**上复验,各两次):
     *
     * | 发给 /zen/v1/messages 的凭证头 | 状态 |
     * |---|---|
     * | 仅 `Authorization: Bearer <key>` | **500** Internal server error |
     * | 仅 `x-api-key: <key>`            | 403 FreeTierError |
     * | 两者都带                          | 403 FreeTierError |
     *
     * 403 说明请求**走到了免费额度闸门**(凭证被识别),500 说明它在那之前
     * 就崩了 —— 上游这个面从 `x-api-key` 读凭证。另两个面只认 Bearer。
     *
     * **不修的后果**:500 → `classifyStatus` 归 `upstream_error` →
     * `isRetryable` 为真且**归咎于 Worker** → 重试链把每个 Worker 依次试一遍,
     * 每个都记一次失败并进指数退避。于是一个**配置完全正确**的网关,
     * 只要客户端用 Messages 面就会把整池 Worker 打进冷却,而症状是
     * "上游好像挂了",完全指不到真实原因(少发了一个头)。
     *
     * 不变量 #4 要保的正是这件事,而这里破坏它的不是客户端的坏请求,
     * 是我们自己少发了一个头。
     */
    const out = messagesSurface.extraUpstreamHeaders({
      apiKey: "fake-key-not-real",
      streaming: false,
    });
    expect(out["x-api-key"]).toBe("fake-key-not-real");
  });

  it("空 key 不镜像一个空头", () => {
    /*
     * `x-api-key: `(空值)与"没有这个头"在上游侧不一定等价。
     * 免 key 的 Worker 本就不会进转发候选链(isUsable 只看 key)。
     */
    const out = messagesSurface.extraUpstreamHeaders({ apiKey: "", streaming: false });
    expect(out["x-api-key"]).toBeUndefined();
    // 但 anthropic-version 仍然要有 —— 它与凭证无关。
    expect(out["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  });

  it("anthropic-version 由网关设定 —— 值是固定常量", () => {
    /*
     * 实测它对结果没有影响(带与不带都是同样的状态码),但 Anthropic 协议
     * 要求它,而上游哪天开始校验时我们不该是"恰好没发"的那一方。
     *
     * 必须由网关给:取自客户端头的话,一个伪造的旧版本号就是协议降级原语。
     */
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
    const out = messagesSurface.extraUpstreamHeaders({ apiKey: "k", streaming: true });
    expect(out["anthropic-version"]).toBe("2023-06-01");
  });

  it("本面**无**体内会话标识 —— Anthropic Messages 是无状态的", () => {
    // 整个对话每次完整重发,没有 previous_response_id 那样的链式指针。
    expect(messagesSurface.sessionKeyFrom({ previous_response_id: "x" })).toBeUndefined();
  });

  it("两种形态都支持,所以是 optional 而非 sse", () => {
    // 收紧成"必须流式"会拒掉合法的非流式请求,而两种都常用。
    expect(messagesSurface.streaming).toBe("optional");
  });
});

describe("三个面一起注册 —— Phase 6 的验收条件", () => {
  it("buildRegistry 注册三个面,六条路径,无冲突", () => {
    /*
     * 规划的验收条件:新增一个面 = 加一个文件 + 注册一行,不动路由装配、
     * 鉴权、调度、重试、统计。这条断言钉住"三个面真的都注册进去了" ——
     * 而鉴权守卫与路由都从 `registry.paths()` 推导,所以它们自动跟上。
     */
    const r = buildRegistry();
    expect(r.size).toBe(3);
    expect(r.ids().sort()).toEqual(["chat", "messages", "responses"]);
    expect(r.paths().sort()).toEqual([
      "/chat/completions",
      "/messages",
      "/responses",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
    ]);
  });

  it("每个面都实现了 parseUsage —— 不能有面漏掉它", () => {
    /*
     * `parseUsage` 是 Phase 7 的门槛所依赖的成员。它是**必填**的接口成员,
     * 所以漏掉会 typecheck 失败 —— 但这条断言覆盖的是另一种漏法:
     * 实现了却直接 `return null`(那在类型上完全合法)。
     *
     * 用各面自己的信封喂一份真实形状的载荷,每个面都必须出数。
     */
    const r = buildRegistry();
    const envelopes: Record<string, unknown> = {
      chat: { usage: { prompt_tokens: 5, completion_tokens: 2 } },
      responses: { response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      messages: { message: { usage: { input_tokens: 5, output_tokens: 2 } } },
    };
    for (const id of r.ids()) {
      const surface = r.get(id);
      expect(surface).not.toBeNull();
      expect(surface?.parseUsage(envelopes[id])).not.toBeNull();
    }
  });
});
