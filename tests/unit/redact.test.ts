import { describe, expect, it } from "vitest";
import { redactText, redactUrl, redactValue, safeErrorMessage } from "../../src/shared/redact.ts";

/*
 * 全部用明显虚构的凭证，绝不从真实配置复制 fixture。
 */

describe("redactUrl", () => {
  it("丢掉 path 与 query —— 订阅 token 常藏在那里", () => {
    expect(redactUrl("https://sub.example.invalid/link/TOKEN123?token=SECRET")).toBe(
      "https://sub.example.invalid/…",
    );
  });

  it("保留 host 与端口以便诊断", () => {
    expect(redactUrl("http://127.0.0.1:9090/proxies")).toBe("http://127.0.0.1:9090/…");
  });

  it("剥掉 URL 内嵌的 user:pass", () => {
    const out = redactUrl("http://alice:hunter2@proxy.example.invalid:8080/path");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("alice");
    expect(out).toBe("http://proxy.example.invalid:8080/…");
  });

  it("无 path 无 query 时不加省略号", () => {
    expect(redactUrl("https://opencode.ai")).toBe("https://opencode.ai");
  });

  it("不是 URL 时整体脱敏，不回显片段", () => {
    expect(redactUrl("这不是URL但可能含secret=abc")).toBe("[已脱敏]");
  });
});

describe("redactText", () => {
  it("脱敏 Bearer token", () => {
    const out = redactText("upstream said: Authorization: Bearer zen-fake-abcdefgh123456");
    expect(out).not.toContain("abcdefgh123456");
  });

  it("脱敏 key=value 形态", () => {
    const out = redactText("request failed apiKey=zen_fake_KEY_0123456789 host=example.invalid");
    expect(out).not.toContain("zen_fake_KEY_0123456789");
    expect(out).toContain("host=example.invalid");
  });

  it("脱敏代理 URL 内嵌口令", () => {
    const out = redactText("connect socks5://bob:s3cret@10.0.0.1:1080 failed");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("bob");
  });

  it("控制字符换成空格 —— CR/LF 能伪造日志行", () => {
    const out = redactText("line one\r\nFAKE: forged log line\tend");
    expect(out).not.toMatch(/[\r\n\t]/);
    expect(out).toContain("line one");
  });

  it("截断发生在脱敏之后，避免把凭证切成两半绕过规则", () => {
    // 让凭证正好横跨截断点：先截断的实现会把后半段原样留下。
    const secret = "zen-fake-" + "Z".repeat(60);
    const out = redactText(`${"x".repeat(470)} ${secret}`, 500);
    expect(out).not.toContain("ZZZZZZZZZZ");
  });

  it("不含凭证的短文本原样返回", () => {
    expect(redactText("upstream 429 rate limited")).toBe("upstream 429 rate limited");
  });
});

describe("redactValue", () => {
  it("按字段名脱敏值，保留结构", () => {
    const out = redactValue({
      id: "w1",
      apiKey: "zen-fake-SECRET-VALUE",
      nested: { password: "hunter2", host: "example.invalid" },
    }) as Record<string, unknown>;

    expect(out["id"]).toBe("w1");
    expect(out["apiKey"]).toBe("[已脱敏]");
    expect((out["nested"] as Record<string, unknown>)["password"]).toBe("[已脱敏]");
    expect((out["nested"] as Record<string, unknown>)["host"]).toBe("example.invalid");
  });

  it("字段名归一化：api_key / api-key / apiKey 都算凭证", () => {
    const out = redactValue({ api_key: "a1234567", "api-key": "b1234567", apiKey: "c1234567" }) as Record<
      string,
      unknown
    >;
    expect(Object.values(out)).toEqual(["[已脱敏]", "[已脱敏]", "[已脱敏]"]);
  });

  it("区分「空 key」与「有 key」—— 两者是不同的故障", () => {
    const out = redactValue({ apiKey: "" }) as Record<string, unknown>;
    expect(out["apiKey"]).toBe("");
  });

  it("以 url 结尾的字段走 URL 脱敏", () => {
    const out = redactValue({ baseUrl: "https://host.invalid/v1?k=SECRET" }) as Record<string, unknown>;
    expect(out["baseUrl"]).toBe("https://host.invalid/…");
  });

  it("层级过深时不递归到栈溢出", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 50; i += 1) deep = { nest: deep };
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).toContain("层级过深");
  });

  it("数组元素也脱敏", () => {
    const out = redactValue([{ token: "abcdefgh" }]) as Array<Record<string, unknown>>;
    expect(out[0]!["token"]).toBe("[已脱敏]");
  });

  it("Error 只留 name 与脱敏后的 message", () => {
    const out = redactValue(new Error("failed with apiKey=zen-fake-123456789")) as Record<string, unknown>;
    expect(out["name"]).toBe("Error");
    expect(String(out["message"])).not.toContain("zen-fake-123456789");
  });
});

describe("safeErrorMessage", () => {
  it("脱敏 Error message", () => {
    expect(safeErrorMessage(new Error("Bearer zen-fake-abcdefgh12345"))).not.toContain("abcdefgh12345");
  });

  it("非 Error 非字符串给固定文案", () => {
    expect(safeErrorMessage({ weird: true })).toBe("未知错误");
  });
});
