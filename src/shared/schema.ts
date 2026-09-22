import { z } from "zod";

/**
 * 配置 schema —— server ⇄ admin ⇄ CLI 的唯一契约。
 *
 * 全部对象都是 strict：手工编辑 config.json 是预期用法（Phase 1-8 无 UI 时
 * 就靠它），拼错字段名必须立刻报错，而不是静默忽略后让人困惑「我明明改了」。
 */

/* ------------------------------------------------------------------ *
 * 基础片段
 * ------------------------------------------------------------------ */

/** 端口：1-65535，且排除需要特权的 0-1023（本工具无须特权端口）。 */
export const PortSchema = z.number().int().min(1024).max(65535);

const HostSchema = z.string().min(1).max(255);

/**
 * 上游 baseUrl。
 *
 * 只允许 http/https —— 换成 file:// 或别的 scheme 会把随请求发出的 Bearer key
 * 变成 SSRF 原语。同时拒绝 URL 里内嵌的 user:pass，那种形态会让凭证出现在
 * 任何打印 baseUrl 的地方（日志、诊断、错误信息）。
 */
export const UpstreamUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "不是合法 URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "只允许 http/https" });
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: "custom", message: "URL 不得内嵌凭证" });
    }
  });

/**
 * Relay Token —— 客户端访问 /v1/* 所需。
 *
 * 首启自动生成，没有「空表示不校验」这种形态：旧项目默认空值等于
 * 本机任何进程都能白用网关，而这是个默认行为，不是用户的选择。
 */
export const RelayTokenSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/, {
  message: "只允许 URL-safe 字符",
});

/* ------------------------------------------------------------------ *
 * 出口代理
 * ------------------------------------------------------------------ */

/** 能直接做 undici/socks 出口的协议。其余协议只能经 Clash 桥接。 */
export const DIRECT_PROTOCOLS = ["http", "https", "socks4", "socks5"] as const;
export const DirectProtocolSchema = z.enum(DIRECT_PROTOCOLS);
export type DirectProtocol = z.infer<typeof DirectProtocolSchema>;

export const ProxySourceSchema = z.enum(["manual", "subscription", "controller"]);

export const ProxySchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    /** 原始协议名，可能是 vless/hysteria2 等只能桥接的类型，故不用 enum 收窄。 */
    type: z.string().min(1).max(32),
    host: HostSchema,
    port: z.number().int().min(1).max(65535),
    username: z.string().max(256).optional(),
    password: z.string().max(512).optional(),
    enabled: z.boolean().default(true),
    source: ProxySourceSchema,
    subscriptionId: z.string().min(1).max(128).optional(),
    /** 经 Clash Controller 导入时所属的 selector 分组。 */
    controllerGroup: z.string().max(200).optional(),
    bridgeId: z.string().min(1).max(128).optional(),
    /** Clash selector 里的节点名，通常与 name 相同。 */
    clashNodeName: z.string().max(200).optional(),
    /** 能否直连出口（协议在 DIRECT_PROTOCOLS 内）。 */
    direct: z.boolean().default(false),
    /** 能否经本地 Clash 桥接出口。 */
    bridgeable: z.boolean().default(false),
    /**
     * 最近一次实测到的公网出口 IP。
     * 出口隔离判定必须按这个字段分组，不能按 id —— 两个不同代理
     * 可能 NAT 到同一个公网 IP，那种情况下隔离是假的。
     */
    egressIp: z.string().max(64).nullable().default(null),
  })
  .refine((p) => p.direct || p.bridgeable, {
    message: "既不能直连也不能桥接的代理无法使用",
  });
export type Proxy = z.infer<typeof ProxySchema>;

/* ------------------------------------------------------------------ *
 * 订阅
 * ------------------------------------------------------------------ */

export const SubscriptionSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  /**
   * 订阅 URL 通常把 token 带在 query 或 path 里，本身即凭证。
   * 打印前必须过 redactUrl()。
   */
  url: UpstreamUrlSchema,
  enabled: z.boolean().default(true),
  lastFetchedAt: z.string().max(64).nullable().default(null),
  /** 只存分类后的失败原因，不存上游原始文本（可能回显 URL 含的 token）。 */
  lastErrorKind: z.string().max(64).nullable().default(null),
  lastImportCount: z.number().int().nonnegative().default(0),
  lastFormat: z.string().max(64).nullable().default(null),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/* ------------------------------------------------------------------ *
 * Clash 桥接
 * ------------------------------------------------------------------ */

export const ClashBridgeSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  /** 数值越小越优先（auto 模式下多个健康内核时的取舍）。 */
  priority: z.number().int().min(0).max(999).default(100),
  apiBase: UpstreamUrlSchema,
  /** Controller secret，是凭证，任何输出前必须脱敏。 */
  apiSecret: z.string().max(512).default(""),
  localProxyHost: HostSchema.default("127.0.0.1"),
  localProxyPort: z.number().int().min(1).max(65535),
  selectorGroup: z.string().min(1).max(200).default("GLOBAL"),
});
export type ClashBridge = z.infer<typeof ClashBridgeSchema>;

export const ClashConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  selectionMode: z.enum(["manual", "auto"]).default("auto"),
  /** manual 模式下选中的内核；auto 模式下记最近一个健康内核。 */
  activeBridgeId: z.string().min(1).max(128).nullable().default(null),
  bridges: z.array(ClashBridgeSchema).max(32).default([]),
});
export type ClashConfig = z.infer<typeof ClashConfigSchema>;

/* ------------------------------------------------------------------ *
 * Worker
 * ------------------------------------------------------------------ */

export const WorkerKindSchema = z.enum(["anonymous", "authenticated"]);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

export const WorkerSchema = z
  .strictObject({
    id: z.string().min(1).max(128),
    name: z.string().max(200).default(""),
    kind: WorkerKindSchema,
    /** Zen API key。匿名 Worker 为空串。是凭证。 */
    apiKey: z.string().max(512).default(""),
    enabled: z.boolean().default(true),
    /** 绑定的出口代理 id；null 表示直连本机网络出口。 */
    proxyId: z.string().min(1).max(128).nullable().default(null),
  })
  .refine((w) => w.kind === "anonymous" || w.apiKey.trim() !== "", {
    message: "登录态 Worker 必须有 apiKey",
  });
export type Worker = z.infer<typeof WorkerSchema>;

/* ------------------------------------------------------------------ *
 * 模型规则（配置驱动，不改代码就能跟上 Zen 目录变化）
 * ------------------------------------------------------------------ */

export const ProtocolIdSchema = z.enum(["chat", "responses", "messages"]);
export type ProtocolId = z.infer<typeof ProtocolIdSchema>;

export const ModelRulesSchema = z.strictObject({
  /** 免费模型的 id 后缀约定。 */
  freeSuffix: z.string().min(1).max(32).default("-free"),
  /**
   * 无 `-free` 后缀但实际零费率的模型。
   *
   * 这是**出厂默认值**，不是代码里的硬编码判定 —— 用户可改，Phase 6 的
   * 定时刷新会按真实目录纠正它。旧项目把等价的名单写死在代码常量里
   * （`SPECIAL_FREE_MODEL_IDS`），目录一变就必须改代码发版。
   *
   * 2026-09-22 实测 Zen 目录（经 models.dev）：105 个模型、32 个零费率，
   * 其中只有这两个不带 `-free` 后缀。同时确认 `union-alpha` 已从目录消失
   * —— 旧代码把它硬编码为特例，正是改成配置驱动的直接理由。
   */
  extraFreeIds: z
    .array(z.string().min(1).max(128))
    .max(256)
    .default(["big-pickle", "grok-code"]),
  /** 默认支持的协议面。 */
  defaultSurfaces: z.array(ProtocolIdSchema).min(1).default(["chat", "responses"]),
  /** 按模型覆写协议面。 */
  surfaceOverrides: z.record(z.string().min(1).max(128), z.array(ProtocolIdSchema)).default({}),
});
export type ModelRules = z.infer<typeof ModelRulesSchema>;

/* ------------------------------------------------------------------ *
 * 调度
 * ------------------------------------------------------------------ */

export const RoutingStrategySchema = z.enum(["anonymous_first", "authenticated_first", "mixed"]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

export const CooldownConfigSchema = z.strictObject({
  /** 限流：长冷却，但 Retry-After 优先。 */
  rateLimitMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
  /**
   * 鉴权失败：短退避。
   * 故意比限流短得多 —— 一个配错的 key 应该反复暴露，
   * 而不是安静消失 15 分钟让人以为是别的问题。
   */
  authFailMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** 传输失败：指数退避起点与上限。 */
  transportBaseMs: z.number().int().min(100).max(60_000).default(2_000),
  transportMaxMs: z.number().int().min(1_000).max(600_000).default(120_000),
});
export type CooldownConfig = z.infer<typeof CooldownConfigSchema>;

export const RoutingConfigSchema = z.strictObject({
  strategy: RoutingStrategySchema.default("anonymous_first"),
  /*
   * 用 prefault 而不是 default。
   *
   * zod 4 的 `.default({})` 把字面量 `{}` 原样插入，**不会**再跑内层 schema
   * 的默认值 —— 于是 cooldown 的四个字段全是 undefined，之后任何读它们的
   * 代码都会静默拿到 undefined 而不是配置里写的冷却时长。
   * `.prefault({})` 会把 `{}` 过一遍 schema，内层默认值才真的生效。
   */
  cooldown: CooldownConfigSchema.prefault({}),
  /** 会话亲和的存活时长。 */
  affinityTtlMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/* ------------------------------------------------------------------ *
 * 网关
 * ------------------------------------------------------------------ */

export const GatewaySchema = z.strictObject({
  port: PortSchema.default(9876),
  baseUrl: UpstreamUrlSchema.default("https://opencode.ai/zen/v1"),
  relayToken: RelayTokenSchema,
  /** 单次上游请求等待响应头的上限。 */
  headersTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /**
   * 响应体字节之间的空闲上限。
   * 与 headersTimeout 分开是必须的：用单一总时长会把一条正常的长 SSE
   * 到点掐断（整个 fetch 被 abort，响应体一起没）。
   */
  bodyTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  /** 一条客户端请求最多尝试几个 Worker。 */
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export type Gateway = z.infer<typeof GatewaySchema>;

/* ------------------------------------------------------------------ *
 * 顶层
 * ------------------------------------------------------------------ */

/** 当前配置格式版本。加字段不必升版本；改语义/改形状才升，并配迁移。 */
export const CONFIG_VERSION = 1;

export const ConfigSchema = z
  .strictObject({
    version: z.number().int().min(1).max(CONFIG_VERSION),
    gateway: GatewaySchema,
    // prefault 而非 default：见 RoutingConfigSchema.cooldown 处的说明。
    routing: RoutingConfigSchema.prefault({}),
    models: ModelRulesSchema.prefault({}),
    workers: z.array(WorkerSchema).max(512).default([]),
    proxies: z.array(ProxySchema).max(2048).default([]),
    subscriptions: z.array(SubscriptionSchema).max(64).default([]),
    clash: ClashConfigSchema.prefault({}),
  })
  /*
   * 引用完整性。
   *
   * 这不是洁癖 —— 一个指向已删除代理的 Worker 会静默退回本机直连出口，
   * 于是它和其他 Worker 共用同一个公网 IP，而出口隔离正是本项目存在的理由。
   * 这种失败必须在加载配置时就暴露，不能等到 Zen 因同 IP 多账号而封号。
   */
  .superRefine((cfg, ctx) => {
    const proxyIds = new Set(cfg.proxies.map((p) => p.id));
    const subIds = new Set(cfg.subscriptions.map((s) => s.id));
    const bridgeIds = new Set(cfg.clash.bridges.map((b) => b.id));

    const dup = (label: string, ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) {
          ctx.addIssue({ code: "custom", path: [path, i, "id"], message: `${label} id 重复：${id}` });
        }
        seen.add(id);
      });
    };
    dup("Worker", cfg.workers.map((w) => w.id), "workers");
    dup("代理", cfg.proxies.map((p) => p.id), "proxies");
    dup("订阅", cfg.subscriptions.map((s) => s.id), "subscriptions");
    dup("Clash 内核", cfg.clash.bridges.map((b) => b.id), "clash.bridges");

    cfg.workers.forEach((w, i) => {
      if (w.proxyId !== null && !proxyIds.has(w.proxyId)) {
        ctx.addIssue({
          code: "custom",
          path: ["workers", i, "proxyId"],
          message: `引用了不存在的代理 ${w.proxyId}；若确实要直连请显式写 null`,
        });
      }
    });

    cfg.proxies.forEach((p, i) => {
      if (p.subscriptionId !== undefined && !subIds.has(p.subscriptionId)) {
        ctx.addIssue({
          code: "custom",
          path: ["proxies", i, "subscriptionId"],
          message: `引用了不存在的订阅 ${p.subscriptionId}`,
        });
      }
      if (p.bridgeId !== undefined && !bridgeIds.has(p.bridgeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["proxies", i, "bridgeId"],
          message: `引用了不存在的 Clash 内核 ${p.bridgeId}`,
        });
      }
    });

    if (cfg.clash.activeBridgeId !== null && !bridgeIds.has(cfg.clash.activeBridgeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["clash", "activeBridgeId"],
        message: `引用了不存在的 Clash 内核 ${cfg.clash.activeBridgeId}`,
      });
    }

    // 只能桥接的代理，在 Clash 关闭时用不了 —— 配置层面就矛盾。
    if (!cfg.clash.enabled) {
      cfg.proxies.forEach((p, i) => {
        if (!p.direct && p.bridgeable && p.enabled) {
          ctx.addIssue({
            code: "custom",
            path: ["proxies", i],
            message: `${p.name} 只能经 Clash 桥接，但 clash.enabled 为 false`,
          });
        }
      });
    }
  });
export type Config = z.infer<typeof ConfigSchema>;
