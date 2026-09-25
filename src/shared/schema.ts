import { z } from "zod";
import { isIpAddress } from "./ip.ts";

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

/**
 * 内部标识符（Worker / 代理 / 订阅 / Clash 内核的 id）。
 *
 * 字符集必须收窄,因为**这些 id 会进 HTTP 头**:转发响应带
 * `x-zen-gateway-worker: <worker.id>`。先前 id 是任意字符串,于是一个含
 * CRLF 的 id 会让 `Headers.set()` 抛 TypeError —— 而那个异常发生在
 * 上游**已经成功**之后,客户端拿到裸 500、上游响应体既不转发也不释放。
 *
 * id 是本机自动生成或用户手填的短标识,没有任何理由包含这些字符。
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:\-]+$/, { message: "id 只允许字母、数字与 . _ : - " });

/**
 * 凭证字符串（Zen API key、代理口令、Controller secret）。
 *
 * 不限定具体字符集（上游可能用任意可打印字符），但**必须排除控制字符**:
 * `apiKey` 会被拼进 `Authorization: Bearer <key>`,含 CRLF 的值会让 undici
 * 在 fetch 时抛错,而那个失败被 `classifyError` 归为 `transport` →
 * 客户端收到「502 上游不可达」,尽管请求根本没发出去。归因完全错位。
 *
 * 用逐码点检查而非正则:这段处理凭证,而源码里的字面控制字符在本项目
 * 已被工具改写过（见 redact.ts）。
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
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
  // 不得含空白或控制字符:host 会进 URL 与 SOCKS 握手,`a\nb` 这类值
  // 在拼接场景下是注入原语,而它先前是合法的。
  .regex(/^[A-Za-z0-9._:\-[\]%]+$/, { message: "host 只允许主机名/IP 字面量字符" });

/**
 * 实测到的公网出口 IP。
 *
 * 必须是合法 IP 字面量:这个字段是**出口隔离的分组键**。
 * 若允许任意字符串,一段被劫持的回显响应或一次手工误编辑就会变成一个
 * 独立的「出口」,于是每个垃圾值自成一组、看起来全都不同 —— 误报已隔离。
 * `null` 表示尚未探测出,与「确认不同」是两件事。
 */
const EgressIpSchema = z
  .string()
  .max(45)
  .refine((v) => isIpAddress(v), { message: "不是合法的 IPv4/IPv6 字面量" });

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
    /**
     * 最近一次实测到的公网出口 IP。
     * 出口隔离判定必须按这个字段分组，不能按 id —— 两个不同代理
     * 可能 NAT 到同一个公网 IP，那种情况下隔离是假的。
     */
    egressIp: EgressIpSchema.nullable().default(null),
  })
  .refine((p) => p.direct || p.bridgeable, {
    message: "既不能直连也不能桥接的代理无法使用",
  });
export type Proxy = z.infer<typeof ProxySchema>;

/* ------------------------------------------------------------------ *
 * 订阅
 * ------------------------------------------------------------------ */

export const SubscriptionSchema = z.strictObject({
  id: IdSchema,
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

/* ------------------------------------------------------------------ *
 * Worker
 * ------------------------------------------------------------------ */

export const WorkerKindSchema = z.enum(["anonymous", "authenticated"]);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

export const WorkerSchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().max(200).default(""),
    kind: WorkerKindSchema,
    /** Zen API key。匿名 Worker 为空串。是凭证。 */
    apiKey: SecretSchema.default(""),
    enabled: z.boolean().default(true),
    /** 绑定的出口代理 id；null 表示直连本机网络出口。 */
    proxyId: IdSchema.nullable().default(null),
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
   * 2026-09-22 以**上游权威目录**核实：`GET https://opencode.ai/zen/v1/models`
   * （免鉴权）返回 **76 个在架模型**，其中 9 个带 `-free` 后缀且全部真免费，
   * 外加 `big-pickle` 一个零费率无后缀模型 —— 共 10 个免费模型。
   * 所以这里**只需一条例外**。
   *
   * 不要用 models.dev 的 `opencode` provider 做这份名单：它当日报 105 个模型 /
   * 32 个零费率，与在架目录比对后发现 **23 个零费率项已下架**（`glm-5-free`、
   * `kimi-k2.5-free`、`minimax-m3-free`、`grok-code` …）。本文件先前的默认值
   * 里就混进了 `grok-code` —— 它在 Zen 自己的目录和定价页里都不存在，
   * 与旧项目硬编码 `union-alpha` 是同一类错误，只是来源换成了第三方聚合站。
   *
   * 注意 `jev-1.13`（无后缀）**不免费**：定价页是输入 $0.042 / 输出免费，
   * 只有 `jev-1.13-free` 才免费。它不能进这份名单。
   */
  extraFreeIds: z.array(z.string().min(1).max(128)).max(256).default(["big-pickle"]),
  /** 默认支持的协议面。 */
  defaultSurfaces: z.array(ProtocolIdSchema).min(1).default(["chat", "responses"]),
  /** 按模型覆写协议面。 */
  surfaceOverrides: z
    .record(z.string().min(1).max(128), z.array(ProtocolIdSchema))
    // 与其他集合一样设上限:配置文件是手工可编辑的,无界 record 会让
    // 一次误粘贴变成启动期的内存与校验开销。目录总量才百余个模型。
    .refine((r) => Object.keys(r).length <= 512, { message: "最多 512 条覆写" })
    .default({}),
  /**
   * 在架目录缓存的新鲜期。
   *
   * 默认 30 分钟。模型目录以**天**为单位变化（实测 09-22 是 76 条、09-23 是
   * 79 条），所以没必要更短；而更长会让用户刚补进 `extraFreeIds` 的新模型
   * 等太久才生效。
   *
   * 这是**新鲜期**而不是硬过期：过期只触发一次后台刷新，拉不到就继续用旧的。
   * 目录永不因为"太旧"而失效 —— 一份三天前的目录远好于"网关拒绝一切"。
   * 见 `core/models/catalog.ts`。
   *
   * 下限 1 分钟：更短会让每个请求都在刷目录，而那是转发链路上的额外网络依赖。
   */
  catalogTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .default(30 * 60 * 1000),
  /**
   * 免费判定是否与在架目录求交集。
   *
   * 默认开。关掉它等于回到 Phase 5 的行为（放得偏宽：已下架的 `xxx-free`
   * 会被放行，然后由上游返回 400）。
   *
   * ## 它的作用范围只有一条：**目录存在时是否求交集**
   *
   * 先前这里写的理由是「交集依赖能联网拉到目录，而离线环境拉不到，那种情况下
   * 用户应当能明确关掉它，而不是困在『网关不放行任何模型』里」——
   * **那个前提不成立**：`judgeFree` 在目录缺失时**已经放行**了
   * （返回 `*_unverified`，见 `core/models/free.ts` 的「目录缺失时放行」那节）。
   *
   * 实测两个取值在离线场景下对转发**完全无差别**（都放行），对 `/v1/models`
   * 也无差别（都 502）。所以照那句注释在离线时关掉它，什么都不会改变 ——
   * 而用户会以为自己配错了别的东西。
   *
   * 真实的用途是：本地假上游或镜像的目录与真实上游不一致时，交集会误拒 ——
   * 那种情况下关掉它。
   */
  enforceCatalog: z.boolean().default(true),
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
  /**
   * **本机直连**出口最近一次实测到的公网 IP（缺口 #28）。
   *
   * 为什么它要有个地方存：`proxyId: null` 的 Worker 走本机网络出口，
   * 而**它与某个代理 NAT 到同一个公网 IP 恰好是「看起来隔离其实没隔离」
   * 的那种形态** —— 所以它必须参与隔离分组。
   *
   * 先前探测会真的跑（结果映射到合成 id `__direct__`），但 `config.proxies`
   * 里没有那一行，于是测量被丢弃：每次批测白发一次网络请求，
   * 而直连 Worker 在隔离报告里永远是「未探测」。
   *
   * 放在 `gateway` 而不是造一条假的 `Proxy`：本机直连**不是**一个代理
   * （没有 host/port/协议可言），硬塞成 Proxy 会让 `resolveProxy`、
   * dispatcher 缓存、UI 列表都要为这个特例开分支。
   */
  directEgressIp: EgressIpSchema.nullable().default(null),
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

    /*
     * 校验消息**不得插值任何用户数据**。
     *
     * `issue.path` 已经精确指到出错的元素（如 `workers.0.proxyId`），
     * 再把值拼进消息只带来一个后果：config.ts 的 formatIssues 会把它
     * 放进 ConfigError.message，而那条消息会进日志、终端、以及用户
     * 粘贴的报错。代理 name 来自订阅导入 —— 那正是「测试不得用真实
     * 订阅数据」所要保护的同一类数据。
     */
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
