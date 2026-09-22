import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  CONFIG_VERSION,
  ProxySchema,
  UpstreamUrlSchema,
  WorkerSchema,
} from "../../src/shared/schema.ts";

/** 最小合法配置；各用例在此之上只改自己关心的部分。 */
function base(overrides: Record<string, unknown> = {}) {
  return {
    version: CONFIG_VERSION,
    gateway: { relayToken: "A".repeat(32) },
    ...overrides,
  };
}

const directProxy = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `节点 ${id}`,
  type: "socks5",
  host: "127.0.0.1",
  port: 1080,
  source: "manual" as const,
  direct: true,
  ...extra,
});

describe("嵌套默认值真的生效（prefault 回归守卫）", () => {
  /*
   * zod 4 的 `.default({})` 把字面量 `{}` 原样插入，不跑内层 schema 的默认值。
   * 这个 bug 不会让 parse 失败 —— 它让 cooldown.rateLimitMs 之类静默变成
   * undefined，直到运行期某处拿它做算术才炸。必须由测试钉住。
   */
  it("routing.cooldown 的每个字段都有具体数值", () => {
    const cfg = ConfigSchema.parse(base());
    expect(cfg.routing.cooldown.rateLimitMs).toBeGreaterThan(0);
    expect(cfg.routing.cooldown.authFailMs).toBeGreaterThan(0);
    expect(cfg.routing.cooldown.transportBaseMs).toBeGreaterThan(0);
    expect(cfg.routing.cooldown.transportMaxMs).toBeGreaterThan(0);
  });

  it("鉴权失败的冷却明显短于限流冷却", () => {
    const { cooldown } = ConfigSchema.parse(base()).routing;
    // 配错的 key 应该反复暴露，而不是安静消失 15 分钟让人以为是别的问题。
    expect(cooldown.authFailMs).toBeLessThan(cooldown.rateLimitMs);
  });

  it("clash.bridges 是数组而非 undefined", () => {
    const cfg = ConfigSchema.parse(base());
    expect(Array.isArray(cfg.clash.bridges)).toBe(true);
  });

  it("models 规则的默认值完整", () => {
    const cfg = ConfigSchema.parse(base());
    expect(cfg.models.freeSuffix).toBe("-free");
    expect(cfg.models.defaultSurfaces).toContain("chat");
  });

  it("extraFreeIds 出厂默认含实测到的无后缀免费模型", () => {
    /*
     * 2026-09-22 实测 Zen 目录：105 个模型、32 个零费率，其中只有
     * big-pickle 与 grok-code 不带 -free 后缀。这是**默认值**而非代码里的
     * 硬编码判定 —— 用户可改，Phase 6 的定时刷新会按真实目录纠正。
     * 旧项目把等价名单写死成代码常量，目录一变就要改代码发版。
     */
    const cfg = ConfigSchema.parse(base());
    expect(cfg.models.extraFreeIds).toContain("big-pickle");
    expect(cfg.models.extraFreeIds).toContain("grok-code");
    // union-alpha 已从目录消失，绝不能再出现在默认值里。
    expect(cfg.models.extraFreeIds).not.toContain("union-alpha");
  });

  it("extraFreeIds 可被配置覆盖为空", () => {
    // 目录变化不该需要改代码。
    const cfg = ConfigSchema.parse(base({ models: { extraFreeIds: [] } }));
    expect(cfg.models.extraFreeIds).toEqual([]);
  });

  it("gateway 的 headers 与 body 超时是两个独立值", () => {
    const { gateway } = ConfigSchema.parse(base());
    // 用单一总时长会把正常的长 SSE 到点掐断。
    expect(gateway.headersTimeoutMs).toBeGreaterThan(0);
    expect(gateway.bodyTimeoutMs).toBeGreaterThan(gateway.headersTimeoutMs);
  });
});

describe("baseUrl 的 scheme 限制", () => {
  it.each(["file:///etc/passwd", "ftp://host.invalid/x", "gopher://host.invalid"])(
    "拒绝 %s",
    (url) => {
      // 非 http(s) scheme 会把随请求发出的 Bearer key 变成 SSRF 原语。
      expect(UpstreamUrlSchema.safeParse(url).success).toBe(false);
    },
  );

  it("拒绝内嵌凭证的 URL", () => {
    expect(UpstreamUrlSchema.safeParse("https://user:pass@host.invalid/v1").success).toBe(false);
  });

  it("接受正常的 http/https", () => {
    expect(UpstreamUrlSchema.safeParse("https://opencode.ai/zen/v1").success).toBe(true);
    expect(UpstreamUrlSchema.safeParse("http://127.0.0.1:9090").success).toBe(true);
  });
});

describe("Relay Token", () => {
  it("拒绝空值 —— 空等于本机任何进程都能白用网关", () => {
    expect(ConfigSchema.safeParse(base({ gateway: { relayToken: "" } })).success).toBe(false);
  });

  it("拒绝过短的值", () => {
    expect(ConfigSchema.safeParse(base({ gateway: { relayToken: "abc" } })).success).toBe(false);
  });
});

describe("引用完整性", () => {
  it("Worker 指向不存在的代理时报错", () => {
    /*
     * 这条最关键：指向已删除代理的 Worker 会静默退回本机直连出口，
     * 于是它和别的 Worker 共用同一个公网 IP —— 而出口隔离正是本项目
     * 存在的理由。必须在加载配置时就暴露，不能等到 Zen 因同 IP 多账号封号。
     */
    const result = ConfigSchema.safeParse(
      base({
        workers: [{ id: "w1", kind: "anonymous", proxyId: "已删除的代理" }],
        proxies: [],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("proxyId");
  });

  it("Worker 显式写 null 表示直连，合法", () => {
    const result = ConfigSchema.safeParse(
      base({ workers: [{ id: "w1", kind: "anonymous", proxyId: null }] }),
    );
    expect(result.success).toBe(true);
  });

  it("Worker 指向存在的代理，合法", () => {
    const result = ConfigSchema.safeParse(
      base({
        workers: [{ id: "w1", kind: "anonymous", proxyId: "p1" }],
        proxies: [directProxy("p1")],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("代理指向不存在的订阅时报错", () => {
    const result = ConfigSchema.safeParse(
      base({ proxies: [directProxy("p1", { source: "subscription", subscriptionId: "没有这个" })] }),
    );
    expect(result.success).toBe(false);
  });

  it("clash.activeBridgeId 指向不存在的内核时报错", () => {
    const result = ConfigSchema.safeParse(
      base({ clash: { enabled: true, activeBridgeId: "没有这个内核" } }),
    );
    expect(result.success).toBe(false);
  });

  it.each([
    ["workers", { workers: [{ id: "dup", kind: "anonymous" }, { id: "dup", kind: "anonymous" }] }],
    ["proxies", { proxies: [directProxy("dup"), directProxy("dup")] }],
  ])("%s 的 id 重复时报错", (_label, overrides) => {
    const result = ConfigSchema.safeParse(base(overrides));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("重复");
  });
});

describe("可用性约束", () => {
  it("既不能直连也不能桥接的代理被拒", () => {
    const result = ProxySchema.safeParse({
      ...directProxy("p1"),
      direct: false,
      bridgeable: false,
    });
    expect(result.success).toBe(false);
  });

  it("只能桥接的代理在 clash 关闭时报错", () => {
    const result = ConfigSchema.safeParse(
      base({
        clash: { enabled: false },
        proxies: [
          directProxy("p1", { type: "vless", direct: false, bridgeable: true, enabled: true }),
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("clash.enabled");
  });

  it("只能桥接的代理在 clash 开启时合法", () => {
    const result = ConfigSchema.safeParse(
      base({
        clash: {
          enabled: true,
          bridges: [
            {
              id: "b1",
              name: "本地内核",
              apiBase: "http://127.0.0.1:9090",
              localProxyPort: 7890,
            },
          ],
          activeBridgeId: "b1",
        },
        proxies: [
          directProxy("p1", { type: "vless", direct: false, bridgeable: true, bridgeId: "b1" }),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("登录态 Worker 必须有 apiKey", () => {
    expect(WorkerSchema.safeParse({ id: "w1", kind: "authenticated", apiKey: "" }).success).toBe(
      false,
    );
    expect(
      WorkerSchema.safeParse({ id: "w1", kind: "authenticated", apiKey: "zen-fake-key" }).success,
    ).toBe(true);
  });

  it("匿名 Worker 无需 apiKey", () => {
    expect(WorkerSchema.safeParse({ id: "w1", kind: "anonymous" }).success).toBe(true);
  });
});

describe("egressIp 语义", () => {
  it("默认为 null —— 未探测过不等于已隔离", () => {
    const proxy = ProxySchema.parse(directProxy("p1"));
    expect(proxy.egressIp).toBeNull();
  });
});

describe("未知字段", () => {
  it("顶层拼错字段名立刻报错", () => {
    expect(ConfigSchema.safeParse({ ...base(), workerz: [] }).success).toBe(false);
  });

  it("嵌套对象里拼错字段名也报错", () => {
    expect(
      ConfigSchema.safeParse(base({ gateway: { relayToken: "A".repeat(32), prot: 1234 } })).success,
    ).toBe(false);
  });
});
