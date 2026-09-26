import { z } from "zod";
import { isIpAddress } from "./ip.ts";
import { isControlCode } from "./redact.ts";

/**
 * 配置 schema —— server ⇄ admin ⇄ CLI 的唯一契约。
 * 全部对象都是 strict：手工编辑 config.json 是预期用法，拼错字段名必须立刻报错。
 */

/** 网关监听端口：1024-65535，本工具不需要特权端口。 */
export const PortSchema = z.number().int().min(1024).max(65535);

/**
 * 探测结果里表示本机直连出口的合成 id，落盘时写进 `gateway.directEgressIp`。
 * 定义在 `shared/`：`IdSchema` 要拒绝它，而 `egress.ts` 依赖本文件，反向 import 会成环。
 */
export const DIRECT_EGRESS_ID = "__direct__";

/**
 * 内部标识符（Worker / 代理 / 订阅 / Clash 内核的 id）。字符集收窄是因为 id 会进
 * `x-zen-gateway-worker` 响应头：含 CRLF 会让 `Headers.set()` 在上游成功后抛错。
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:\-]+$/, { message: "id 只允许字母、数字与 . _ : - " })
  // 拒绝合成 id：同名代理会与直连共用探测结果和 `DispatcherPool` 缓存，出口隔离失效。
  .refine((id) => id !== DIRECT_EGRESS_ID, {
    message: `"${DIRECT_EGRESS_ID}" 是保留 id（表示本机直连出口），不能用作代理或 Worker 的 id`,
  });

/**
 * 凭证字符串（Zen API key、代理口令、Controller secret）必须排除控制字符：
 * 含 CRLF 的 key 会让 undici 抛错，被误归为 `transport` 而报「上游不可达」。
 * 逐码点检查而非正则，避免源码里出现字面控制字符（见 redact.ts）。
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

export const SecretSchema = z
  .string()
  .max(512)
  .refine((v) => !hasControlChars(v), { message: "凭证不得含控制字符或换行" });

const HostSchema = z
  .string()
  .min(1)
  .max(255)
  // host 会进 URL 与 SOCKS 握手，空白或控制字符是注入原语。
  .regex(/^[A-Za-z0-9._:\-[\]%]+$/, { message: "host 只允许主机名/IP 字面量字符" });

/**
 * 实测到的公网出口 IP。必须是合法 IP 字面量：它是回显出口报告的分组键，
 * 垃圾值会自成一组而误报出口独立。
 */
const EgressIpSchema = z
  .string()
  .max(45)
  .refine((v) => isIpAddress(v), { message: "不是合法的 IPv4/IPv6 字面量" });

/**
 * 上游 baseUrl。只允许 http/https，避免 Bearer key 被发往其他 scheme；
 * 拒绝内嵌 user:pass，否则凭证会出现在任何打印 baseUrl 的地方。
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

/** Relay Token，客户端访问 /v1/* 所需。首启自动生成，不支持「空表示不校验」。 */
export const RelayTokenSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/, {
  message: "只允许 URL-safe 字符",
});

/** 能直接做 undici/socks 出口的协议。其余协议只能经 Clash 桥接。 */
export const DIRECT_PROTOCOLS = ["http", "https", "socks4", "socks5"] as const;
export const DirectProtocolSchema = z.enum(DIRECT_PROTOCOLS);
export type DirectProtocol = z.infer<typeof DirectProtocolSchema>;

export const ProxySourceSchema = z.enum(["manual", "subscription", "controller"]);

export const ProxySchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().min(1).max(200),
    /** 原始协议名，可能是 vless/hysteria2 等只能桥接的类型，故不用 enum 收窄。 */
    type: z.string().min(1).max(32),
    host: HostSchema,
    port: z.number().int().min(1).max(65535),
    username: z.string().max(256).optional(),
    password: SecretSchema.optional(),
    enabled: z.boolean().default(true),
    source: ProxySourceSchema,
    subscriptionId: IdSchema.optional(),
    /** 经 Clash Controller 导入时所属的 selector 分组。 */
    controllerGroup: z.string().max(200).optional(),
    bridgeId: IdSchema.optional(),
    /** Clash selector 里的节点名，通常与 name 相同。 */
    clashNodeName: z.string().max(200).optional(),
    /** 能否直连出口（协议在 DIRECT_PROTOCOLS 内）。 */
    direct: z.boolean().default(false),
    /** 能否经本地 Clash 桥接出口。 */
    bridgeable: z.boolean().default(false),
    /** 最近一次实测的公网出口 IP。隔离判定按它分组而非按 id：不同代理可能 NAT 到同一 IP。 */
    egressIp: EgressIpSchema.nullable().default(null),
  })
  .refine((p) => p.direct || p.bridgeable, {
    message: "既不能直连也不能桥接的代理无法使用",
  });
export type Proxy = z.infer<typeof ProxySchema>;

export const SubscriptionSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  /** 订阅 URL 本身即凭证，打印前必须过 redactUrl()。 */
  url: UpstreamUrlSchema,
  enabled: z.boolean().default(true),
  lastFetchedAt: z.string().max(64).nullable().default(null),
  /** 只存分类后的失败原因，不存上游原始文本（可能回显 URL 含的 token）。 */
  lastErrorKind: z.string().max(64).nullable().default(null),
  lastImportCount: z.number().int().nonnegative().default(0),
  lastFormat: z.string().max(64).nullable().default(null),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const ClashBridgeSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  enabled: z.boolean().default(true),
  /** 数值越小越优先（auto 模式下多个健康内核时的取舍）。 */
  priority: z.number().int().min(0).max(999).default(100),
  apiBase: UpstreamUrlSchema,
  /** Controller secret，是凭证，任何输出前必须脱敏。 */
  apiSecret: SecretSchema.default(""),
  localProxyHost: HostSchema.default("127.0.0.1"),
  localProxyPort: z.number().int().min(1).max(65535),
  selectorGroup: z.string().min(1).max(200).default("GLOBAL"),
});
export type ClashBridge = z.infer<typeof ClashBridgeSchema>;

export const ClashConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  selectionMode: z.enum(["manual", "auto"]).default("auto"),
  /** manual 模式下选中的内核；auto 模式下记最近一个健康内核。 */
  activeBridgeId: IdSchema.nullable().default(null),
  bridges: z.array(ClashBridgeSchema).max(32).default([]),
});
export type ClashConfig = z.infer<typeof ClashConfigSchema>;

export const WorkerKindSchema = z.enum(["anonymous", "authenticated"]);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

export const WorkerSchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().max(200).default(""),
    kind: WorkerKindSchema,
    /** Zen API key。匿名 Worker 归一化为空串；认证 Worker 必须提供。是凭证。 */
    apiKey: SecretSchema.default(""),
    enabled: z.boolean().default(true),
    /** 绑定的出口代理 id；null 表示直连本机网络出口。 */
    proxyId: IdSchema.nullable().default(null),
  })
  .refine((w) => w.kind === "anonymous" || w.apiKey.trim() !== "", {
    message: "登录态 Worker 必须有 apiKey",
  })
  .transform((w) =>
    w.kind === "anonymous"
      ? {
          ...w,
          // 匿名身份不携带认证凭证；这里是配置归一化的唯一入口。
          apiKey: "",
        }
      : w,
  );
export type Worker = z.infer<typeof WorkerSchema>;

export const ProtocolIdSchema = z.enum(["chat", "responses", "messages"]);
export type ProtocolId = z.infer<typeof ProtocolIdSchema>;

export const ModelRulesSchema = z.strictObject({
  /** 免费模型的 id 后缀约定。 */
  freeSuffix: z.string().min(1).max(32).default("-free"),
  /**
   * 无 `-free` 后缀但实际零费率的模型。这是可改的出厂默认值，不是代码硬编码判定。
   * 名单以 Zen 在架目录为准，不用 models.dev 等第三方聚合（含已下架项）。
   * `jev-1.13`（无后缀）不免费，不能进这份名单。
   */
  extraFreeIds: z.array(z.string().min(1).max(128)).max(256).default(["big-pickle"]),
  /**
   * 默认声明支持的协议面：仅供 Models 页展示（经 `surfacesFor()`），不是放行闸门。
   * 未观察到上游按模型区分协议面，接成闸门会在默认配置下拒掉所有 `/v1/messages`。
   * 真正的流式放行判定在 `ProtocolSurface.streaming`，由 `relay.ts` 第 4 步执行。
   */
  defaultSurfaces: z.array(ProtocolIdSchema).min(1).default(["chat", "responses"]),
  /** 按模型覆写协议面，同样只作展示。 */
  surfaceOverrides: z
    .record(z.string().min(1).max(128), z.array(ProtocolIdSchema))
    // 与其他集合一样设上限，防止手工误粘贴造成启动期开销。
    .refine((r) => Object.keys(r).length <= 512, { message: "最多 512 条覆写" })
    .default({}),
  /**
   * 在架目录缓存的新鲜期（非硬过期）：过期只触发后台刷新，拉不到继续用旧目录，
   * 见 `core/models/catalog.ts`。下限 1 分钟，避免转发链路频繁刷目录。
   */
  catalogTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(30 * 60 * 1000),
  /**
   * 目录存在时免费判定是否与在架目录求交集。不是离线开关：目录缺失时
   * `judgeFree` 已放行（`*_unverified`）。用于本地假上游或镜像目录与真实上游不一致时关闭。
   */
  enforceCatalog: z.boolean().default(true),
});
export type ModelRules = z.infer<typeof ModelRulesSchema>;

export const RoutingStrategySchema = z.enum(["anonymous_first", "authenticated_first", "mixed"]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

export const CooldownConfigSchema = z.strictObject({
  /** 限流：长冷却，但 Retry-After 优先。 */
  rateLimitMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
  /** 鉴权失败：短退避，让配错的 key 反复暴露而不是安静消失。 */
  authFailMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /**
   * 上游 403：很短的冷却。免费闸门按请求形态返回 403 且先于密钥校验，
   * 长冷却会把请求形态问题放大成 Worker 不可用。
   */
  forbiddenMs: z.number().int().min(1_000).max(600_000).default(5_000),
  /** 传输失败：指数退避起点与上限。 */
  transportBaseMs: z.number().int().min(100).max(60_000).default(2_000),
  transportMaxMs: z.number().int().min(1_000).max(600_000).default(120_000),
});
export type CooldownConfig = z.infer<typeof CooldownConfigSchema>;

export const RoutingConfigSchema = z.strictObject({
  strategy: RoutingStrategySchema.default("anonymous_first"),
  // prefault 而非 default：zod 4 的 `.default({})` 不执行内层默认值。
  cooldown: CooldownConfigSchema.prefault({}),
  /** 会话亲和的存活时长。 */
  affinityTtlMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const GatewaySchema = z.strictObject({
  port: PortSchema.default(9876),
  baseUrl: UpstreamUrlSchema.default("https://opencode.ai/zen/v1"),
  relayToken: RelayTokenSchema,
  /** 单次上游请求等待响应头的上限。 */
  headersTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** 响应体字节之间的空闲上限。与 headersTimeout 分开，单一总时长会掐断正常的长 SSE。 */
  bodyTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  /** 一条客户端请求最多尝试几个 Worker。 */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /**
   * 本机直连出口最近一次实测的公网 IP（探测 id `__direct__`）。直连 Worker 也必须
   * 参与隔离分组。放在 `gateway` 而非伪造一条 `Proxy`，免得 `resolveProxy` 等处开特例。
   */
  directEgressIp: EgressIpSchema.nullable().default(null),
});
export type Gateway = z.infer<typeof GatewaySchema>;

/** 当前配置格式版本。加字段不必升版本；改语义/改形状才升，并配迁移。 */
export const CONFIG_VERSION = 1;

/** 配置里 Worker 的总数上限；管理 API 一次批量创建的上限与它相同。 */
export const MAX_WORKERS = 512;

export const ConfigSchema = z
  .strictObject({
    version: z.number().int().min(1).max(CONFIG_VERSION),
    gateway: GatewaySchema,
    // prefault 而非 default：见 RoutingConfigSchema.cooldown 处的说明。
    routing: RoutingConfigSchema.prefault({}),
    models: ModelRulesSchema.prefault({}),
    workers: z.array(WorkerSchema).max(MAX_WORKERS).default([]),
    proxies: z.array(ProxySchema).max(2048).default([]),
    subscriptions: z.array(SubscriptionSchema).max(64).default([]),
    clash: ClashConfigSchema.prefault({}),
  })
  // 引用完整性：指向已删除代理的 Worker 会静默退回直连、破坏出口隔离，必须加载时暴露。
  .superRefine((cfg, ctx) => {
    const proxyIds = new Set(cfg.proxies.map((p) => p.id));
    const subIds = new Set(cfg.subscriptions.map((s) => s.id));
    const bridgeIds = new Set(cfg.clash.bridges.map((b) => b.id));

    // 校验消息不插值用户数据：`issue.path` 已定位元素，消息会进 ConfigError 与日志。
    const dup = (label: string, ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) {
          ctx.addIssue({ code: "custom", path: [path, i, "id"], message: `${label} id 与前面的条目重复` });
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
          message: "引用了不存在的代理；若确实要直连请显式写 null",
        });
      }
    });

    cfg.proxies.forEach((p, i) => {
      if (p.subscriptionId !== undefined && !subIds.has(p.subscriptionId)) {
        ctx.addIssue({
          code: "custom",
          path: ["proxies", i, "subscriptionId"],
          message: "引用了不存在的订阅",
        });
      }
      if (p.bridgeId !== undefined && !bridgeIds.has(p.bridgeId)) {
        ctx.addIssue({
          code: "custom",
          path: ["proxies", i, "bridgeId"],
          message: "引用了不存在的 Clash 内核",
        });
      }
    });

    if (cfg.clash.activeBridgeId !== null && !bridgeIds.has(cfg.clash.activeBridgeId)) {
      ctx.addIssue({
        code: "custom",
        path: ["clash", "activeBridgeId"],
        message: "引用了不存在的 Clash 内核",
      });
    }

    // 只能桥接的代理，在 Clash 关闭时用不了 —— 配置层面就矛盾。
    if (!cfg.clash.enabled) {
      cfg.proxies.forEach((p, i) => {
        if (!p.direct && p.bridgeable && p.enabled) {
          ctx.addIssue({
            code: "custom",
            path: ["proxies", i],
            message: "该代理只能经 Clash 桥接，但 clash.enabled 为 false",
          });
        }
      });
    }
  });
export type Config = z.infer<typeof ConfigSchema>;
