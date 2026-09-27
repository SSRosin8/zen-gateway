import { z } from "zod";
import { BATCH_STATES } from "./batchProbe.ts";
import {
  ClashBridgeSchema,
  ClashConfigSchema,
  CooldownConfigSchema,
  GatewaySchema,
  IdSchema,
  ModelRulesSchema,
  ProxySourceSchema,
  RoutingConfigSchema,
  RoutingStrategySchema,
  SubscriptionSchema,
  WorkerKindSchema,
  MAX_WORKERS,
} from "./schema.ts";

/** server ⇄ admin ⇄ CLI 的唯一契约；三端都从这里推导类型。配置 schema 在 `schema.ts`。 */

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  /** 应答进程的 pid。service.mjs 据此验明身份再发 SIGTERM：状态文件里的 PID 可能已被复用。 */
  pid: z.number().int().positive(),
  /**
   * 统计与亲和持久化的累计写失败次数。store 吞掉写异常以免影响转发，
   * 这里让失败可诊断；非 0 说明统计数字不可信。
   */
  storeWriteFailures: z.number().int().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Worker 池健康态。`empty` 独立一态：否则 0 个 Worker 时 `0 === 0` 会显示为全部健康。 */
export const PoolHealthSchema = z.enum(["empty", "healthy", "degraded"]);
export type PoolHealth = z.infer<typeof PoolHealthSchema>;

export function poolHealth(counts: { ready: number; total: number }): PoolHealth {
  if (counts.total === 0) return "empty";
  return counts.ready === counts.total ? "healthy" : "degraded";
}

/*
 * 管理 API 响应不直接回 `Config`：配置里含全部凭证。以下是展示投影，
 * 凭证字段换成「有没有」与指纹；投影必须窄于存储（不是重复定义，纪律 #4）。
 */

/** 凭证的展示形态：只说有没有，绝不回显。 */
export const SecretPresenceSchema = z.object({
  /** 是否已配置（非空）。 */
  present: z.boolean(),
  /**
   * sha256 前 8 位，仅供人眼比对；未配置时为 null。刻意不复用
   * `credentialFingerprint.ts`：那是决定重建连接的安全边界，这里只需短到能显示。
   */
  fingerprint: z.string().length(8).nullable(),
});
export type SecretPresence = z.infer<typeof SecretPresenceSchema>;

/** Worker 运行期视图：配置与 `Scheduler` 状态合在一处，只有服务进程同时持有两者。 */
export const WorkerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkerKindSchema,
  enabled: z.boolean(),
  /** 绑定的出口代理 id；null = 本机直连。 */
  proxyId: z.string().nullable(),
  apiKey: SecretPresenceSchema,
  /** 是否在调度器候选池里。与 `enabled` 不同：认证 Worker 还要求 apiKey 非空，匿名 Worker 免 key。 */
  inPool: z.boolean(),
  /** 现在是否就绪（不在冷却中）。`inPool` 为假时恒为 false。 */
  ready: z.boolean(),
  /** 冷却剩余毫秒。0 = 不在冷却。 */
  cooldownRemainingMs: z.number().int().nonnegative(),
  consecutiveFails: z.number().int().nonnegative(),
  /** 最近一次失败的类别，供回答「为什么在冷却」。 */
  lastFailure: z.string().nullable(),
  /** 最近一次实测到的公网出口 IP（来自绑定代理）；null = 未探测出。 */
  egressIp: z.string().nullable(),
});
export type WorkerView = z.infer<typeof WorkerViewSchema>;

/** 回显目标的出口分组，按实测 IP 而非代理 id；不代表 Zen 实际出口。 */
export const IsolationGroupViewSchema = z.object({
  egressIp: z.string(),
  workerIds: z.array(z.string()),
  proxyIds: z.array(z.string()),
});

export const IsolationViewSchema = z.object({
  groups: z.array(IsolationGroupViewSchema),
  /** 尚未探测出回显 IP 的 Worker，不能判断该目标是否使用独立出口。 */
  unknownWorkerIds: z.array(z.string()),
  /** 存在共用出口的组。非空即隔离失败。 */
  sharedGroups: z.array(IsolationGroupViewSchema),
  isolated: z.boolean(),
});
export type IsolationView = z.infer<typeof IsolationViewSchema>;

/** 目录槽位状态，对应 `ModelCatalog.status()`。 */
export const CatalogSlotViewSchema = z.object({
  slot: z.enum(["keyless", "keyed"]),
  total: z.number().int().nonnegative(),
  ageMs: z.number().int().nonnegative(),
});

/** Overview 页的聚合端点：一次请求保证页面上的数字来自同一时刻的状态。 */
export const OverviewSchema = z.object({
  health: HealthSchema,
  gateway: z.object({
    port: z.number().int(),
    baseUrl: z.string(),
    relayToken: SecretPresenceSchema,
    maxAttempts: z.number().int(),
    headersTimeoutMs: z.number().int(),
    bodyTimeoutMs: z.number().int(),
  }),
  /** 调度设置的当前值，供网关页表单回填。 */
  routing: z.object({
    strategy: RoutingStrategySchema,
    affinityTtlMs: z.number().int(),
    cooldown: z.object({
      rateLimitMs: z.number().int(),
      authFailMs: z.number().int(),
      forbiddenMs: z.number().int(),
      transportBaseMs: z.number().int(),
      transportMaxMs: z.number().int(),
    }),
  }),
  pool: z.object({
    ready: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    health: PoolHealthSchema,
  }),
  workers: z.array(WorkerViewSchema),
  isolation: IsolationViewSchema,
  catalog: z.object({
    slots: z.array(CatalogSlotViewSchema),
    /** 当前身份下的免费模型数。拉不到目录时为 null（不是 0）。 */
    freeCount: z.number().int().nonnegative().nullable(),
  }),
  clash: z.object({
    enabled: z.boolean(),
    selectionMode: z.enum(["manual", "auto"]),
    activeBridgeId: z.string().nullable(),
    bridges: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        priority: z.number().int(),
        apiBase: z.string(),
        apiSecret: SecretPresenceSchema,
        localProxyHost: z.string(),
        localProxyPort: z.number().int(),
        selectorGroup: z.string(),
      }),
    ),
  }),
  /** 代理数量概览。完整列表由 `/api/proxies` 提供。 */
  proxies: z.object({
    total: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative(),
    withEgressIp: z.number().int().nonnegative(),
  }),
});
export type Overview = z.infer<typeof OverviewSchema>;

/** 被拒请求里的 `model` 不像模型 id 时进库用的占位符；服务端写入与前端显示共用。 */
export const UNKNOWN_MODEL = "<other>";

/** 统计视图，对应 `StatsStore` 的聚合。`requests` 与 `attempts` 分开：一条重试链是一个请求、多次尝试。 */
export const StatsViewSchema = z.object({
  /** 起始日（UTC 日期键）；null = 全部历史。 */
  sinceDay: z.string().nullable(),
  requests: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  models: z.array(
    z.object({
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(),
      requestsWithUsage: z.number().int().nonnegative(),
      requestsWithoutUsage: z.number().int().nonnegative(),
      requestsDroppedUsage: z.number().int().nonnegative(),
    }),
  ),
  workers: z.array(
    z.object({
      workerId: z.string(),
      attempts: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
      lastUsedAt: z.number().nullable(),
      lastStatus: z.number().int().nullable(),
    }),
  ),
  rates: z.object({
    /** null = 还没有带 usage 的请求（不是 0%）。 */
    cacheHitRate: z.number().nullable(),
    usageCoverage: z.number().nullable(),
    /** 非 0 说明网关自己没解析完整，要看界定常量而非上游。 */
    droppedUsageCount: z.number().int().nonnegative(),
  }),
  /** 网关自己拒掉的请求，按原因汇总。 */
  rejections: z.record(z.string(), z.number().int().nonnegative()),
  /** 同一批拒绝按（原因, 模型名）展开；客户端给的名字不像模型 id 时记为 `<other>`。 */
  rejectedModels: z.array(
    z.object({ reason: z.string(), model: z.string(), count: z.number().int().nonnegative() }),
  ),
});
export type StatsView = z.infer<typeof StatsViewSchema>;

/** 管理面错误体。形状与转发面 `gatewayError` 一致，让 admin 只需一个错误解析函数；类型取值不同。 */
export const AdminErrorSchema = z.object({
  error: z.object({
    type: z.enum([
      /** 请求体不合法（非 JSON、超限、schema 不过）。 */
      "invalid_request",
      /** 合并后的配置违反 schema 或引用完整性。 */
      "invalid_config",
      /** 写盘失败（权限、磁盘满）。 */
      "write_failed",
      /** 要改的东西不存在（未知 Worker id 等）。 */
      "not_found",
      /** 与进行中的操作冲突（批量探测、订阅刷新），不排队，稍后重试。 */
      "conflict",
      /** Clash Controller 连得上但要求 secret；局域网登录口令不对也用它。 */
      "auth_required",
      /** 局域网访问尚未登录或会话已过期（回环闸门直接返回）。 */
      "lan_login_required",
      "internal_error",
    ]),
    message: z.string(),
  }),
});
export type AdminError = z.infer<typeof AdminErrorSchema>;
/** `adminError()` 的形参类型，从 schema 推导而不另写联合（纪律 #4）。 */
export type AdminErrorType = AdminError["error"]["type"];

/**
 * 凭证字段的写入语义：缺席 = 不动，`{ set }` = 换新值，`{ clear: true }` = 清空。
 * 清空必须显式：否则前端提交的空输入框会静默清掉一个能用的 key（前端拿不到原值）。
 */
export const SecretPatchSchema = z.union([
  z.strictObject({ set: z.string().max(512) }),
  z.strictObject({ clear: z.literal(true) }),
]);
export type SecretPatch = z.infer<typeof SecretPatchSchema>;

/**
 * Worker 的可改字段，缺席即不动。不含 `id`：调度器冷却状态按 id 索引，
 * 改 id 会抹掉上游要求的冷却等待；要换 id 就显式删建。
 */
export const WorkerPatchSchema = z.strictObject({
  kind: WorkerKindSchema.optional(),
  name: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  /** null = 改为本机直连；缺席 = 不动。 */
  proxyId: z.string().nullable().optional(),
  apiKey: SecretPatchSchema.optional(),
});
export type WorkerPatch = z.infer<typeof WorkerPatchSchema>;

/** 新建 Worker。认证 Worker 必须提供 API key；匿名 Worker 可以留空。 */
export const WorkerCreateSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:\-]+$/, { message: "id 只允许字母、数字与 . _ : - " }),
  name: z.string().max(200).default(""),
  kind: WorkerKindSchema.optional(),
  apiKey: z.string().max(512).default(""),
  proxyId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type WorkerCreate = z.infer<typeof WorkerCreateSchema>;

/** 网关设置的可改字段。不含 `port`：改它要重启，只能改配置文件。 */
export const GatewayPatchSchema = z.strictObject({
  maxAttempts: GatewaySchema.shape.maxAttempts.unwrap().optional(),
  headersTimeoutMs: GatewaySchema.shape.headersTimeoutMs.unwrap().optional(),
  bodyTimeoutMs: GatewaySchema.shape.bodyTimeoutMs.unwrap().optional(),
  /** 除三态外还可 `{ rotate: true }`：服务端用首启同一个生成器换新 token，响应不回显。 */
  relayToken: z.union([SecretPatchSchema, z.strictObject({ rotate: z.literal(true) })]).optional(),
});

/** 调度设置的可改字段；取值范围沿用 `RoutingConfigSchema`。 */
export const RoutingPatchSchema = z.strictObject({
  strategy: RoutingStrategySchema.optional(),
  affinityTtlMs: RoutingConfigSchema.shape.affinityTtlMs.unwrap().optional(),
  cooldown: z
    .strictObject({
      rateLimitMs: CooldownConfigSchema.shape.rateLimitMs.unwrap().optional(),
      authFailMs: CooldownConfigSchema.shape.authFailMs.unwrap().optional(),
      forbiddenMs: CooldownConfigSchema.shape.forbiddenMs.unwrap().optional(),
      transportBaseMs: CooldownConfigSchema.shape.transportBaseMs.unwrap().optional(),
      transportMaxMs: CooldownConfigSchema.shape.transportMaxMs.unwrap().optional(),
    })
    .optional(),
});

const bridge = ClashBridgeSchema.shape;

/** Clash 内核的可改字段。不含 `id`：代理的 `bridgeId` 按 id 引用。`apiSecret` 走凭证三态。 */
export const BridgePatchSchema = z.strictObject({
  name: bridge.name.optional(),
  enabled: bridge.enabled.unwrap().optional(),
  priority: bridge.priority.unwrap().optional(),
  apiBase: bridge.apiBase.optional(),
  apiSecret: SecretPatchSchema.optional(),
  localProxyHost: bridge.localProxyHost.unwrap().optional(),
  localProxyPort: bridge.localProxyPort.optional(),
  selectorGroup: bridge.selectorGroup.unwrap().optional(),
});

export const ClashPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  selectionMode: ClashConfigSchema.shape.selectionMode.unwrap().optional(),
  activeBridgeId: IdSchema.nullable().optional(),
  bridges: z
    .strictObject({
      /** 直接用存储 schema：默认值与校验只有一处。 */
      create: z.array(ClashBridgeSchema).max(32).optional(),
      update: z.record(z.string(), BridgePatchSchema).optional(),
      /** 连带删除该内核导入的代理；其中有被 Worker 引用的则整个请求失败。 */
      delete: z.array(z.string()).max(32).optional(),
    })
    .optional(),
});

/** 代理只开放启停与改名；连接信息来自导入，手改会与下次导入冲突。 */
export const ProxiesPatchSchema = z.strictObject({
  update: z
    .record(
      z.string(),
      z.strictObject({ enabled: z.boolean().optional(), name: z.string().min(1).max(200).optional() }),
    )
    .optional(),
  /** 被 Worker 引用的代理拒绝删除：Worker 会静默退回直连，破坏出口隔离。 */
  delete: z.array(z.string()).max(2048).optional(),
});

export const SubscriptionsPatchSchema = z.strictObject({
  create: z
    .array(SubscriptionSchema.pick({ id: true, name: true, url: true, enabled: true }))
    .max(64)
    .optional(),
  /** `url` 是凭证，走三态写入且永不回显。 */
  update: z
    .record(
      z.string(),
      z.strictObject({
        name: SubscriptionSchema.shape.name.optional(),
        url: SecretPatchSchema.optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .optional(),
  /** 连带删除该订阅导入的代理；其中有被 Worker 引用的则整个请求失败。 */
  delete: z.array(z.string()).max(64).optional(),
});

/** 模型规则的可改字段。Models 页编辑其中的后缀、名单与交集开关。 */
export const ModelRulesPatchSchema = z.strictObject({
  freeSuffix: ModelRulesSchema.shape.freeSuffix.unwrap().optional(),
  extraFreeIds: ModelRulesSchema.shape.extraFreeIds.unwrap().optional(),
  catalogTtlMs: ModelRulesSchema.shape.catalogTtlMs.unwrap().optional(),
  enforceCatalog: z.boolean().optional(),
});

/**
 * 配置补丁：管理面写入的唯一入口形状。配置是一个文件、`saveConfig` 整份原子写，
 * 单一 patch 避免多端点读-改-写之间的丢失更新。`workers` 分 create/update/delete
 * 而非数组覆盖：前端拿不到 apiKey 原值，覆盖式写入会抹掉所有 key。
 *
 * 补丁侧一律 `strictObject`：否则拼错的字段被静默丢弃，产出空 patch 却返回成功。
 * 响应侧投影保持 `z.object`，由 `admin/project.ts` 构造，加诊断字段不应是破坏性改动。
 */
/** 一次 `workers.create` 的条数上限，与配置里 Worker 总数上限一致；后台批量导入按它分批提示。 */
export const WORKER_CREATE_MAX = MAX_WORKERS;

export const ConfigPatchSchema = z.strictObject({
  gateway: GatewayPatchSchema.optional(),
  routing: RoutingPatchSchema.optional(),
  models: ModelRulesPatchSchema.optional(),
  clash: ClashPatchSchema.optional(),
  proxies: ProxiesPatchSchema.optional(),
  subscriptions: SubscriptionsPatchSchema.optional(),
  workers: z
    .strictObject({
      /** 上限与 `ConfigSchema.workers` 一致：从 Clash 节点批量建 Worker 要一次提交。 */
      create: z.array(WorkerCreateSchema).max(WORKER_CREATE_MAX).optional(),
      /** 按 id 定位；id 不存在则整个请求失败（`not_found`），不静默跳过。 */
      update: z.record(z.string(), WorkerPatchSchema).optional(),
      delete: z.array(z.string()).max(512).optional(),
    })
    .optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/** 代理的展示形态。`password` 换成 `SecretPresence`，其余字段原样供排查。 */
export const ProxyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  host: z.string(),
  port: z.number().int(),
  enabled: z.boolean(),
  source: ProxySourceSchema,
  bridgeId: z.string().nullable(),
  clashNodeName: z.string().nullable(),
  direct: z.boolean(),
  bridgeable: z.boolean(),
  /** 最近一次实测的公网出口 IP。null = 未探测（不是「没有出口」）。 */
  egressIp: z.string().nullable(),
  password: SecretPresenceSchema,
  /** 引用它的 Worker id。由服务端计算，避免与 `patch.ts` 的引用完整性校验分叉。 */
  usedBy: z.array(z.string()),
  /** 能否被解析成一条可用出口路径（纯本地判断）。 */
  resolvable: z.boolean(),
  /** 不可解析时的原因（已是人可读文案）。 */
  unresolvableReason: z.string().nullable(),
});
export type ProxyView = z.infer<typeof ProxyViewSchema>;

/** 模型的展示形态，带免费判定依据。 */
export const ModelViewSchema = z.object({
  id: z.string(),
  /** 是否放行。 */
  free: z.boolean(),
  /**
   * 判定依据：`suffix`（后缀命中）/ `extra`（在 extraFreeIds 里）/
   * `not_free`（两者都不满足）/ `retired`（依据成立但已下架）/
   * `*_unverified`（依据成立但目录拿不到，没做交集）。
   */
  reason: z.string(),
  /** 该模型在本网关上声明支持的协议面（来自 `surfacesFor`）。 */
  surfaces: z.array(z.string()),
  /** 在上游在架目录里。 */
  listed: z.boolean(),
});
export type ModelView = z.infer<typeof ModelViewSchema>;

/** 订阅的投影。订阅 URL 是凭证（token 常在 query 或 path 里），只给脱敏后的展示串。 */
export const SubscriptionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 已脱敏的 URL，形如 `https://sub.example.com/link?token=***`。 */
  urlRedacted: z.string(),
  enabled: z.boolean(),
  lastFetchedAt: z.string().nullable(),
  /** 只有分类，没有上游原文（原文可能回显 URL 里的 token）。 */
  lastErrorKind: z.string().nullable(),
  lastImportCount: z.number().int().nonnegative(),
  lastFormat: z.string().nullable(),
  /** 当前有多少个代理来自这个订阅。 */
  proxyCount: z.number().int().nonnegative(),
});
export type SubscriptionView = z.infer<typeof SubscriptionViewSchema>;

export const SubscriptionListSchema = z.object({
  subscriptions: z.array(SubscriptionViewSchema),
});
export type SubscriptionList = z.infer<typeof SubscriptionListSchema>;

/** 一次刷新的结果 —— 与 `ImportSummary` 对应。 */
export const SubscriptionRefreshSchema = z.object({
  ok: z.boolean(),
  /** 失败时的分类（`unreachable`/`http_error`/`timeout`/`too_large`/`unparseable`）。 */
  failureKind: z.string().nullable(),
  /** 已脱敏的可读原因。 */
  reason: z.string().nullable(),
  format: z.string().nullable(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** 仍被 Worker 绑着、因此没被删掉的过期节点数。 */
  keptBecauseInUse: z.number().int().nonnegative(),
  /** 因 Clash 未启用而以停用状态导入的节点数。 */
  disabledNeedBridge: z.number().int().nonnegative(),
  /** 解析时被丢弃的条目数（缺 host、端口越界、分组等）。 */
  skipped: z.number().int().nonnegative(),
});
export type SubscriptionRefresh = z.infer<typeof SubscriptionRefreshSchema>;

/**
 * 一次出口探测的逐条结果。与其他管理响应一样经 schema 与投影层，不手工拼装
 * `ProbeOutcome`。用 `strictObject`：多塞的字段在构造响应时就抛，而不是被静默剥掉。
 * `via` 是回显服务 URL，不是凭证。
 */
export const ProbeResultSchema = z.union([
  z.strictObject({
    proxyId: z.string(),
    ok: z.literal(true),
    egressIp: z.string(),
    latencyMs: z.number().int().nonnegative(),
    via: z.string(),
  }),
  z.strictObject({
    proxyId: z.string(),
    ok: z.literal(false),
    failureKind: z.string(),
    /** 已脱敏。`probe.ts` 保证它不含响应正文。 */
    reason: z.string(),
  }),
]);
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProbeReportSchema = z.strictObject({
  ok: z.literal(true),
  /** 是否真的改了配置（有代理的 `egressIp` 发生变化）。 */
  changed: z.boolean(),
  results: z.array(ProbeResultSchema),
});
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

export const ProxyListSchema = z.object({
  proxies: z.array(ProxyViewSchema),
  clash: OverviewSchema.shape.clash,
  /** 回显出口报告，与 Overview 同一份逻辑；不证明 Zen 实际出口隔离。 */
  isolation: IsolationViewSchema,
  /** 订阅列表，供代理池页显示节点来源。 */
  subscriptions: z.array(SubscriptionViewSchema),
});
export type ProxyList = z.infer<typeof ProxyListSchema>;

export const ModelListSchema = z.object({
  /**
   * 在架目录里的全部模型（含付费的），以便解释被拒原因。
   * 目录拿不到时为空数组且 `catalogAvailable` 为 false，与「目录为空」区分。
   */
  models: z.array(ModelViewSchema),
  catalogAvailable: z.boolean(),
  rules: z.object({
    freeSuffix: z.string(),
    extraFreeIds: z.array(z.string()),
    defaultSurfaces: z.array(z.string()),
    catalogTtlMs: z.number().int(),
    enforceCatalog: z.boolean(),
  }),
});
export type ModelList = z.infer<typeof ModelListSchema>;

/** 批量探测进度，形状为 `shared/batchProbe.ts` 的 `BatchProgress` 加 `elapsedMs`。 */
export const BatchProgressSchema = z.object({
  state: z.enum(BATCH_STATES),
  screenTotal: z.number().int().nonnegative(),
  screenDone: z.number().int().nonnegative(),
  mainTotal: z.number().int().nonnegative(),
  mainDone: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  addedWorkerIds: z.array(z.string()),
  failureKind: z.string().nullable(),
  /** 本批已跑多久（毫秒），未开始过为 null。服务端从 `batch_probe_jobs.started_at` 计算。 */
  elapsedMs: z.number().int().nonnegative().nullable(),
});

/** 批测进度的线上形态，前端使用。reducer 是无时钟纯函数，耗时由服务端在读时计算。 */
export type BatchProgressView = z.infer<typeof BatchProgressSchema>;

/** 线上形态的「从未跑过」。`elapsedMs` 为 null 而非 0，区分没开始与刚开始。 */
export const INITIAL_BATCH_VIEW: BatchProgressView = {
  state: "idle",
  screenTotal: 0,
  screenDone: 0,
  mainTotal: 0,
  mainDone: 0,
  cancelRequested: false,
  addedWorkerIds: [],
  failureKind: null,
  elapsedMs: null,
};

/* ---------------- Clash 发现与导入 ---------------- */

/** 显式地址只接受本机 http 回环 —— 服务端另判，这里只限长度与形状。 */
export const ClashDiscoverRequestSchema = z.strictObject({
  apiBase: z.string().min(1).max(2048).optional(),
  secret: z.string().max(512).optional(),
});

export const ClashControllerViewSchema = z.object({
  apiBase: z.string(),
  status: z.enum(["ok", "auth_required", "unreachable"]),
  version: z.string().optional(),
  mode: z.string().optional(),
  mixedPort: z.number().int().nullable().optional(),
  selectorGroup: z.string().optional(),
  nodeCount: z.number().int().nonnegative().optional(),
  /** 已脱敏的原因：连不上、要 secret，或连上了但不能配置（缺 mixed-port 等）。 */
  reason: z.string().optional(),
});
export type ClashControllerView = z.infer<typeof ClashControllerViewSchema>;

export const ClashDiscoverResponseSchema = z.object({
  controllers: z.array(ClashControllerViewSchema),
});
export type ClashDiscoverResponse = z.infer<typeof ClashDiscoverResponseSchema>;

export const ClashImportRequestSchema = z.strictObject({
  apiBase: z.string().min(1).max(2048),
  secret: z.string().max(512).optional(),
  dryRun: z.boolean(),
});

export const ClashImportResponseSchema = z.object({
  ok: z.literal(true),
  dryRun: z.boolean(),
  summary: z.object({
    bridgesAdded: z.number().int().nonnegative(),
    bridgesUpdated: z.number().int().nonnegative(),
    proxiesAdded: z.number().int().nonnegative(),
    proxiesUpdated: z.number().int().nonnegative(),
    selectorGroup: z.string(),
    mixedPort: z.number().int(),
    warnings: z.array(z.string()),
  }),
});
export type ClashImportResponse = z.infer<typeof ClashImportResponseSchema>;

/* ---------------- 诊断 ---------------- */

export const DIAGNOSTIC_LAYER_IDS = ["config", "store", "workers", "clash", "catalog"] as const;

export const DiagnosticLayerSchema = z.object({
  id: z.enum(DIAGNOSTIC_LAYER_IDS),
  title: z.string(),
  status: z.enum(["pass", "warn", "fail", "skip"]),
  summary: z.string(),
  details: z.array(z.string()),
  nextStep: z.string().optional(),
});
export type DiagnosticLayer = z.infer<typeof DiagnosticLayerSchema>;

export const DiagnosticsSchema = z.object({ layers: z.array(DiagnosticLayerSchema) });
export type Diagnostics = z.infer<typeof DiagnosticsSchema>;

/* ---------------- OpenCode 项目配置 ---------------- */

export const OpenCodeViewSchema = z.object({
  /** 相对项目根的路径，恒为 `opencode.json`；不给绝对路径（含用户主目录）。 */
  path: z.string(),
  exists: z.boolean(),
  /** `opencode --version` 的输出；未安装或探测失败为 null。 */
  detectedVersion: z.string().nullable(),
  /** 文件里 opencode provider 的形状；文件不存在、无法解析或没有该 provider 为 null。 */
  shape: z.enum(["v1", "v2"]).nullable(),
  /** baseURL 指向本网关且 apiKey 与当前 Relay Token 一致。 */
  pointsToGateway: z.boolean(),
  /** 文件存在但不能安全改写（JSONC、注释、非对象）时的原因。 */
  unwritableReason: z.string().nullable(),
});
export type OpenCodeView = z.infer<typeof OpenCodeViewSchema>;

/**
 * `POST /api/probe` 的可选请求体。省略 `proxyIds` 时探测全部在用出口；给出时只探这些
 * （`__direct__` 表示本机直连），供前端逐个探测显示进度与代理池的单行探测。
 */
export const ProbeRequestSchema = z.strictObject({
  proxyIds: z.array(z.string().min(1).max(256)).min(1).max(MAX_WORKERS).optional(),
});

/** 局域网访问状态。`local` = 本机浏览器；`addresses` 只返回给本机。 */
export const LanStatusSchema = z.object({
  enabled: z.boolean(),
  local: z.boolean(),
  authenticated: z.boolean(),
  addresses: z.array(z.string()),
});
export type LanStatus = z.infer<typeof LanStatusSchema>;

export const LanLoginRequestSchema = z.strictObject({ password: z.string().min(1).max(256) });

/** 设置局域网访问口令；null = 关闭局域网访问。至少 8 位：它是整个局域网面前唯一的门。 */
export const LanPasswordRequestSchema = z.strictObject({
  password: z.string().min(8, { message: "口令至少 8 位" }).max(256).nullable(),
});

export const OpenCodeWriteRequestSchema = z.strictObject({
  version: z.enum(["1", "2"]).optional(),
});
