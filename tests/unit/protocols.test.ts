import { describe, expect, it } from "vitest";
import { ProtocolRegistry, ProtocolRegistryError } from "../../src/core/protocols/registry.ts";
import { chatSurface } from "../../src/core/protocols/chat.ts";
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
