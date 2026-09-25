import { describe, expect, it, vi } from "vitest";
import {
  MAX_SUBSCRIPTION_BYTES,
  SUBSCRIPTION_USER_AGENTS,
  fetchSubscription,
} from "../../src/core/proxy/subscription/fetch.ts";

/*
 * 订阅拉取的多 UA 协商（Phase 10）。
 *
 * 解析本身在 `tests/unit/subscription.test.ts`（纯函数，穷举）。这里验的是
 * 只在真实网络上才存在的那些麻烦：同一个 URL 换 UA 换格式、超时预算、
 * 重定向降级、体积上限、以及**错误消息绝不泄漏 URL 里的 token**。
 *
 * 全部用注入的假 fetch —— 真实订阅 URL 是凭证，不进测试。
 */

const TOKEN = "s3cr3t-token-not-real";
const URL_WITH_TOKEN = `https://sub.example.invalid/link?token=${TOKEN}`;

const YAML = `proxies:
  - { name: n1, type: vless, server: a.example.invalid, port: 443 }
  - { name: n2, type: vless, server: b.example.invalid, port: 443 }
`;

const URI_LIST = "http://c.example.invalid:8080\nhttp://d.example.invalid:8081";

function res(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe("多 UA 协商", () => {
  it("只按 UA 返格式的订阅：拿到 Clash YAML 就停", async () => {
    /*
     * 机场普遍按 UA 分发：给 `clash` 返 YAML，给别的返 base64 列表或 403。
     * 固定一个 UA 的话，只支持另一种的订阅会永久失败，而错误是"解不出节点"
     * —— 用户无从知道换个 UA 就好了。
     */
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const ua = String((init?.headers as Record<string, string>)["user-agent"]);
      seen.push(ua);
      return ua.startsWith("clash") ? res(YAML) : res("", { status: 403 });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.format).toBe("clash");
    expect(out.result.nodes).toHaveLength(2);
    expect(out.userAgent).toBe("clash");
    // 第一个 UA 就命中 → 不再试后面的。
    expect(seen).toEqual(["clash"]);
  });

  it("前面的 UA 被拒时继续试，最终成功", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const ua = String((init?.headers as Record<string, string>)["user-agent"]);
      seen.push(ua);
      // 只有 v2rayN 能拿到东西（有些机场就是这样）。
      return ua.startsWith("v2rayN") ? res(URI_LIST) : res("", { status: 403 });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.userAgent).toBe("v2rayN/6.45");
    expect(out.result.nodes).toHaveLength(2);
    expect(seen.slice(0, 4)).toEqual([...SUBSCRIPTION_USER_AGENTS].slice(0, 4));
  });

  it("**取最好的结果**，不是第一个非空的", async () => {
    /*
     * 分享链列表能解出 1 个，而 Clash YAML 能解出 2 个且格式更好
     * （带 selector 分组提示）。先返回列表的那个 UA 在前面，
     * 所以"第一个非空就停"会让用户少拿到一半节点。
     */
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const ua = String((init?.headers as Record<string, string>)["user-agent"]);
      // 第一个 UA 只给一条链接，第三个给完整 YAML。
      if (ua === "clash") return res("http://only.example.invalid:8080");
      if (ua === "clash-verge/2.5.2") return res(YAML);
      return res("", { status: 404 });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.format).toBe("clash");
    expect(out.result.nodes).toHaveLength(2);
  });

  it("显式指定 UA 时只试那一个", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["user-agent"]));
      return res(YAML);
    }) as unknown as typeof fetch;

    await fetchSubscription(URL_WITH_TOKEN, { fetchImpl, userAgent: "my-client/1.0" });
    expect(seen).toEqual(["my-client/1.0"]);
  });
});

describe("超时预算", () => {
  it("**总预算**到了就停，不把所有 UA 试完", async () => {
    /*
     * 旧项目试 8 个 UA、每个 45 秒超时 —— 最坏 6 分钟，而它被一个 HTTP
     * 请求同步等着。一个订阅拉不动时，用户要的是"快点告诉我失败了"。
     *
     * 用假时钟：每次尝试推进 20 秒，总预算 40 秒 → 第三次尝试前就该停。
     */
    let clock = 0;
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["user-agent"]));
      clock += 20_000;
      return res("", { status: 500 });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl, now: () => clock });
    expect(out.ok).toBe(false);
    // 5 个 UA 里只试了 2 个 —— 第三次之前预算就超了。
    expect(seen).toHaveLength(2);
  });
});

describe("重定向", () => {
  it("跟随同协议重定向", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      if (urls.length === 1) {
        return new Response("", { status: 302, headers: { location: "https://cdn.example.invalid/real" } });
      }
      return res(YAML);
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(true);
    expect(urls[1]).toBe("https://cdn.example.invalid/real");
  });

  it("**拒绝 https → http 降级** —— 订阅 URL 含 token", async () => {
    /*
     * `redirect: "follow"` 无法表达这个约束，所以手动跟随。
     * 一次降级会让带 token 的 URL 明文出现在网络上。
     */
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 302, headers: { location: "http://plain.example.invalid/x" } }),
    ) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/降级|拒绝/);
    // 而且报错里不能有 token。
    expect(out.reason).not.toContain(TOKEN);
  });

  it("重定向成环时按**跳数**停下，不是靠超时兜底", async () => {
    /*
     * 变异测试逼出来的。第一版只断言"最终返回 false"，而把跳数上限
     * 改成 100000 之后测试**依然全绿** —— 因为单次超时最后会把它掐断
     * （四分类里的「条件被另一层顺带满足」）。
     *
     * 那不是同一件事：靠超时兜底意味着一个成环的订阅要卡满 15 秒，
     * 而且那 15 秒里在空转发请求。所以要断言**请求次数**。
     */
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response("", { status: 302, headers: { location: "https://sub.example.invalid/loop" } });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription("https://sub.example.invalid/loop", { fetchImpl });
    expect(out.ok).toBe(false);
    /*
     * 5 个 UA × (MAX_REDIRECTS + 1) 跳 = 30 次上限。给一点余量，
     * 但远低于"无上限"的量级 —— 关键是它**有界**。
     */
    expect(calls).toBeLessThanOrEqual(40);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("体积上限", () => {
  it("`content-length` 撒谎时也挡得住 —— 边读边计数", async () => {
    /*
     * 只看 `content-length` 不够：那个头可以撒谎，也可以不给
     * （chunked 编码就没有）。所以必须边读边计数。
     */
    const huge = "x".repeat(1024);
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 声称只有 10 字节，实际推 9 MiB。
          for (let i = 0; i < 9 * 1024; i += 1) {
            controller.enqueue(new TextEncoder().encode(huge));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-length": "10" } });
    }) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("too_large");
  });

  it("声明的 content-length 超限时直接拒，不用读", async () => {
    const fetchImpl = vi.fn(async () =>
      res("small", { headers: { "content-length": String(MAX_SUBSCRIPTION_BYTES + 1) } }),
    ) as unknown as typeof fetch;

    const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("too_large");
    // 体积超限不是 UA 的问题 —— 换 UA 也一样，所以只该请求一次。
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("失败分类与脱敏", () => {
  it("「拉到了但解不出」与「拉不到」分开报", async () => {
    /*
     * 两者的下一步完全不同：前者是"订阅换格式了/token 过期返回了 HTML"，
     * 后者是"检查网络与 URL"。合成一句"订阅失败"会让用户从头猜。
     */
    const html = "<html><body>402 Payment Required</body></html>";
    const okButUnparseable = await fetchSubscription(URL_WITH_TOKEN, {
      fetchImpl: vi.fn(async () => res(html)) as unknown as typeof fetch,
    });
    expect(okButUnparseable.ok).toBe(false);
    if (okButUnparseable.ok) return;
    expect(okButUnparseable.kind).toBe("unparseable");

    const unreachable = await fetchSubscription(URL_WITH_TOKEN, {
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(unreachable.ok).toBe(false);
    if (unreachable.ok) return;
    expect(unreachable.kind).toBe("unreachable");
  });

  it("HTTP 错误归 http_error", async () => {
    const out = await fetchSubscription(URL_WITH_TOKEN, {
      fetchImpl: vi.fn(async () => res("", { status: 503 })) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.kind).toBe("http_error");
    expect(out.reason).toContain("503");
  });

  it("**所有失败路径的错误消息都不含 URL 里的 token**", async () => {
    /*
     * 订阅 URL 自带 token，而错误消息会进日志、进界面、进用户粘贴的报错。
     * 这一条扫**每一条**失败路径 —— 逐条写断言的话，下一个新增的失败分支
     * 会不在任何断言里（那正是第八轮在字面 markdown 上踩过的形态）。
     */
    const failures: Array<[string, typeof fetch]> = [
      ["网络失败", vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
      ["HTTP 500", vi.fn(async () => res("", { status: 500 })) as unknown as typeof fetch],
      ["解不出", vi.fn(async () => res("<html>nope</html>")) as unknown as typeof fetch],
      [
        "降级重定向",
        vi.fn(async () => new Response("", { status: 302, headers: { location: "http://x.example.invalid/" } })) as unknown as typeof fetch,
      ],
      [
        "没有 Location 的 3xx",
        vi.fn(async () => new Response("", { status: 302 })) as unknown as typeof fetch,
      ],
      [
        "体积超限",
        vi.fn(async () => res("x", { headers: { "content-length": String(MAX_SUBSCRIPTION_BYTES + 1) } })) as unknown as typeof fetch,
      ],
      [
        "错误里带着完整 URL 的上游消息",
        vi.fn(async () => { throw new Error(`could not connect to ${URL_WITH_TOKEN}`); }) as unknown as typeof fetch,
      ],
    ];

    for (const [name, fetchImpl] of failures) {
      const out = await fetchSubscription(URL_WITH_TOKEN, { fetchImpl });
      expect(out.ok, name).toBe(false);
      if (out.ok) continue;
      expect(out.reason, name).not.toContain(TOKEN);
      // 8 位前缀也不行 —— 查整段挡不住部分泄漏（第八轮的教训）。
      expect(out.reason, name).not.toContain(TOKEN.slice(0, 8));
    }
  });

  it("响应体绝不进错误消息", async () => {
    /*
     * 订阅体里每一行都可能是凭证（ss:// 的 userinfo 段就是密码）。
     * 一个"解不出"的错误如果把体贴进去，就等于把整份订阅打进日志。
     */
    const secretBody = `ss://${Buffer.from("aes-256-gcm:REAL-PASSWORD-LEAK").toString("base64")}@x.example.invalid:8388`;
    // 这个体其实能解出节点，所以构造一个解不出但含密码的。
    const unparseableWithSecret = `<html>password=REAL-PASSWORD-LEAK</html>`;
    for (const body of [secretBody.replace("ss://", "zz://"), unparseableWithSecret]) {
      const out = await fetchSubscription(URL_WITH_TOKEN, {
        fetchImpl: vi.fn(async () => res(body)) as unknown as typeof fetch,
      });
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.reason).not.toContain("REAL-PASSWORD-LEAK");
    }
  });
});
