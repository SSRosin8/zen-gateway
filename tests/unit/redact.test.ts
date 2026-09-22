import { describe, expect, it } from "vitest";
import {
  isSecretKey,
  redactText,
  redactUrl,
  redactValue,
  safeErrorMessage,
} from "../../src/shared/redact.ts";

/*
 * 全部用明显虚构的凭证，绝不从真实配置复制 fixture。
 *
 * 这一组测试的由来:第一版脱敏用「精确字段名白名单 + 窄 kv 正则」,
 * 独立审核实测出 7/8 的文本形态与 10/10 的字段名变体全部漏过,
 * 外加一个二次回溯(100k 字符 3.4s)。现在的实现改为子串匹配 + 输入限长。
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

  it.each([
    ["data: URI", "data:text/plain;base64,U0VDUkVU"],
    ["协议相对", "//host.invalid/p?token=SECRET"],
    ["只有 scheme", "https://"],
  ])("异常输入 %s 不回显凭证片段", (_label, raw) => {
    expect(redactUrl(raw)).not.toContain("SECRET");
  });
});

describe("isSecretKey", () => {
  it.each([
    "apiKey",
    "api_key",
    "api-key",
    "x-api-key",
    "X-Api-Key",
    "proxyPassword",
    "clashSecret",
    "client_secret",
    "bearerToken",
    "zenApiKey",
    "privateKey",
    "secretKey",
    "relayToken",
    "relayAccessToken",
    "Authorization",
    "cookie",
    "sessionId",
    "credentials",
    "auth",
    "pass",
    "psk",
  ])("%s 视为凭证字段", (key) => {
    // 封闭名单追不上真实字段名的变体,故改为子串匹配。
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(["host", "port", "name", "id", "enabled", "latencyMs", "egressIp", "model"])(
    "%s 不是凭证字段",
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );
});

describe("redactText", () => {
  it.each([
    ['{"apiKey":"zen-fake-JSON1"}', "zen-fake-JSON1"],
    ["relayToken=FAKE-RELAY-2", "FAKE-RELAY-2"],
    ["X-OC-Relay-Key: FAKE-HEADER-3", "FAKE-HEADER-3"],
    ["api key: FAKE-SPACE-4", "FAKE-SPACE-4"],
    ["apiSecret=FAKE-SECRET-5", "FAKE-SECRET-5"],
    ["clashSecret=FAKE-CLASH-6", "FAKE-CLASH-6"],
    ["secret => FAKE-ARROW-7", "FAKE-ARROW-7"],
    ["Authorization: Bearer FAKE-BEARER-8", "FAKE-BEARER-8"],
    ["x-api-key: FAKE-XAPI-9", "FAKE-XAPI-9"],
    ['{"password": "FAKE-PW-10"}', "FAKE-PW-10"],
    ["client_secret=FAKE-CS-11", "FAKE-CS-11"],
    ["socks5://bob:FAKE-PROXY-12@10.0.0.1:1080", "FAKE-PROXY-12"],
  ])("脱敏 %s", (input, secret) => {
    /*
     * 这 12 条里有 7 条是第一版漏过的。其中 X-OC-Relay-Key 尤其要紧 ——
     * 那是本网关自己的鉴权头,名字就写在向导生成的 opencode.json 片段里。
     */
    expect(redactText(input)).not.toContain(secret);
  });

  it("代理 URL 里的用户名也一起脱敏", () => {
    const out = redactText("connect socks5://bob:s3cret@10.0.0.1:1080 failed");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("bob");
  });

  it("控制字符换成空格 —— CR/LF 能伪造日志行", () => {
    const out = redactText("line one\r\nFAKE: forged log line\tend");
    expect(out).not.toMatch(/[\r\n\t]/);
    expect(out).toContain("line one");
  });

  it("不含凭证的短文本原样返回", () => {
    expect(redactText("upstream 429 rate limited")).toBe("upstream 429 rate limited");
  });

  it("含 token 字样的纯数值文本不被破坏", () => {
    // 用量日志形如 "input tokens 1234",不该被当成凭证。
    expect(redactText("usage: 1234 prompt tokens")).toContain("1234");
  });

  describe("输入限长(防二次回溯)", () => {
    /*
     * 第一版对纯小写长文本触发二次回溯:100k 字符 3.4s、200k 13s。
     * 这是单线程网关 —— 一个 150k 的上游错误体就能把它卡死 7 秒。
     * `maxLength` 截的是输出,拦不住这件事,必须另设输入上限。
     */
    it.each([100_000, 500_000, 2_000_000])("%i 字符在 100ms 内完成", (n) => {
      const started = Date.now();
      redactText("a".repeat(n));
      expect(Date.now() - started).toBeLessThan(100);
    });

    it.each([
      ["类 scheme 前缀", `${"a".repeat(20_000)}://`],
      ["连续冒号", "a:".repeat(20_000)],
      ["连续 @", "a@".repeat(20_000)],
    ])("病态形态 %s 在 100ms 内完成", (_label, input) => {
      const started = Date.now();
      redactText(input);
      expect(Date.now() - started).toBeLessThan(100);
    });

    it("超长输入带截断标记", () => {
      const out = redactText("x".repeat(50_000));
      expect(out.endsWith("[已截断]")).toBe(true);
    });

    it("截断后的尾部凭证不会泄漏", () => {
      // 先限长再扫描是安全的:kv 规则的值部分贪婪到串尾。
      const out = redactText(`${"x".repeat(20_000)} apiKey=FAKE-TAIL-SECRET`);
      expect(out).not.toContain("FAKE-TAIL-SECRET");
    });
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

  it("覆盖全部字段名变体", () => {
    const secrets = {
      "x-api-key": "F1",
      proxyPassword: "F2",
      clashSecret: "F3",
      bearerToken: "F4",
      client_secret: "F5",
      privateKey: "F6",
      secretKey: "F7",
      credentials: "F8",
      auth: "F9",
      pass: "F10",
      apiKey: "F11",
      relayToken: "F12",
      Authorization: "F13",
      cookie: "F14",
      psk: "F15",
    };
    const out = JSON.stringify(redactValue(secrets));
    for (const [key, value] of Object.entries(secrets)) {
      expect(out, `${key} 泄漏`).not.toContain(`"${value}"`);
    }
  });

  it("区分「空 key」与「有 key」—— 两者是不同的故障", () => {
    expect((redactValue({ apiKey: "" }) as Record<string, unknown>)["apiKey"]).toBe("");
  });

  it("含 token 字样的**数值**字段不脱敏", () => {
    /*
     * 只有字符串可能是凭证。若按名字一律脱敏,inputTokens / cacheReadTokens
     * 这类用量字段会被毁掉,而统计页正靠它们。
     */
    const out = redactValue({ inputTokens: 1234, cacheReadTokens: 56 }) as Record<string, number>;
    expect(out["inputTokens"]).toBe(1234);
    expect(out["cacheReadTokens"]).toBe(56);
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

  describe("容器类型", () => {
    it("Map 不塌缩成空对象", () => {
      // 走 Object.entries 会得到 {},诊断信息全丢。
      const out = redactValue(new Map<string, unknown>([["host", "h.invalid"], ["apiKey", "SECRET"]]));
      expect(out).toEqual({ host: "h.invalid", apiKey: "[已脱敏]" });
    });

    it("Set 转为数组", () => {
      expect(redactValue(new Set([1, 2]))).toEqual([1, 2]);
    });

    it("URL 走 URL 脱敏", () => {
      expect(redactValue(new URL("https://h.invalid/p?token=SECRET"))).toBe("https://h.invalid/…");
    });

    it("Date 转为 ISO 字符串", () => {
      expect(redactValue(new Date("2026-09-22T00:00:00Z"))).toBe("2026-09-22T00:00:00.000Z");
    });
  });

  describe("抛异常的取值器", () => {
    /*
     * Object.entries 会触发 getter,而 getter 可能抛出一个消息里带凭证的错误 ——
     * 那个异常原样穿透脱敏函数,正是本函数存在的目的所要防止的事。
     * 且**不回显那个消息**:它源自正在被脱敏的结构,一个裸凭证字符串
     * 没有 key=value 形态,redactText 认不出来。
     */
    it("凭证名的取值器抛错时不崩、不泄漏", () => {
      const trap = {
        get apiKey(): string {
          throw new Error("boom FAKE-GETTER-SECRET");
        },
      };
      const out = JSON.stringify(redactValue(trap));
      expect(out).not.toContain("FAKE-GETTER-SECRET");
    });

    it("普通字段的取值器抛错时也不泄漏", () => {
      const trap = {
        get harmless(): string {
          throw new Error("boom FAKE-GETTER-2");
        },
      };
      expect(JSON.stringify(redactValue(trap))).not.toContain("FAKE-GETTER-2");
    });

    it("嵌套层的取值器抛错只影响那一层", () => {
      const trap = {
        keep: "visible",
        outer: {
          get inner(): string {
            throw new Error("boom FAKE-GETTER-3");
          },
        },
      };
      const out = JSON.stringify(redactValue(trap));
      expect(out).not.toContain("FAKE-GETTER-3");
      expect(out).toContain("visible");
    });

    it("ownKeys 抛错的 Proxy 不崩", () => {
      const p = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("boom FAKE-PROXY-SECRET");
          },
        },
      );
      expect(JSON.stringify(redactValue(p))).not.toContain("FAKE-PROXY-SECRET");
    });
  });
});

describe("safeErrorMessage", () => {
  it("脱敏 Error message", () => {
    expect(safeErrorMessage(new Error("Bearer zen-fake-abcdefgh12345"))).not.toContain("abcdefgh12345");
  });

  it("非 Error 非字符串给固定文案", () => {
    expect(safeErrorMessage({ weird: true })).toBe("未知错误");
  });

  it("超长错误体不阻塞事件循环", () => {
    // safeErrorMessage(new Error(body)) 是上游错误进日志的主路径。
    const started = Date.now();
    safeErrorMessage(new Error("a".repeat(200_000)));
    expect(Date.now() - started).toBeLessThan(100);
  });
});
