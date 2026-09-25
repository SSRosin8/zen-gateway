import { z } from "zod";

/**
 * server ⇄ admin ⇄ CLI 的唯一契约。
 *
 * Phase 0 只放最小集合以打通类型链路；配置与存储的完整 schema 在 Phase 1。
 * 规则：三端都从这里导入推导类型，任何一端改字段，另两端 typecheck 失败。
 */

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  /**
   * 应答进程的 pid。
   *
   * 供 service.mjs 验明进程身份:光凭状态文件里的数字不能证明那个进程
   * 是我们的服务(PID 会被系统复用),而能应答这个端口的进程就是占着
   * 这个端口的进程 —— 这是「该不该给它发 SIGTERM」的强证明。
   * 管理面仅 loopback,pid 对同一用户不构成信息泄露。
   */
  pid: z.number().int().positive(),
  /**
   * 统计与亲和持久化的**累计写失败次数**。
   *
   * 两个 store 都吞掉写异常（诊断设施不该让转发失败），但**吞掉不等于可以
   * 不知道**：一个一直写失败的库会安静地给出全 0 报表，而那看起来像
   * 「没人用」。第七轮审核指出那个计数此前**没有任何生产读者** ——
   * 与 `Scheduler.snapshot()` 同一形态。
   *
   * 放在 `/health` 而不是等 Phase 8 的 `doctor`：`service.mjs` 本来就在轮询
   * 这个端点，而 doctor 也可以读它 —— 一个出口服务两个消费者。
   *
   * 0 是正常值。非 0 说明库有问题（磁盘满／权限／档位），统计数字不可信。
   */
  storeWriteFailures: z.number().int().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

/**
 * Worker 池的健康态。
 *
 * `empty` 必须是独立的一态，不能折进 `healthy`：全新安装时 Worker 数为 0,
 * 朴素写法 `ready === total` 得到 `0 === 0` 为真，于是首启第一眼就显示
 * 「全部健康」，而实际什么都没配。
 */
export const PoolHealthSchema = z.enum(["empty", "healthy", "degraded"]);
export type PoolHealth = z.infer<typeof PoolHealthSchema>;

export function poolHealth(counts: { ready: number; total: number }): PoolHealth {
  if (counts.total === 0) return "empty";
  return counts.ready === counts.total ? "healthy" : "degraded";
}

/* ------------------------------------------------------------------ *
 * 管理 API（Phase 9）
 * ------------------------------------------------------------------ */

/**
 * ## 为什么管理面的响应要有自己的 schema，而不是直接回 `Config`
 *
 * `config.json` **整个文件都是凭证**（Zen API key、Relay Token、代理口令、
 * Clash secret）。直接把 `Config` 序列化回浏览器等于把全部凭证送到一个
 * 可能被扩展读取、被截图、被 devtools 保存的地方 —— 而管理面**不需要**它们：
 * 用户要看的是「这个 Worker 配没配 key」，不是 key 本身。
 *
 * 所以这里有一组**镜像 schema**：形状与 `Config` 对应，但凭证字段换成
 * 「有没有」的布尔值与指纹。这**不是**重复定义（纪律 #4）—— 两者语义不同，
 * 一个是存储格式，一个是展示投影，而投影必须窄于存储。
 * 写入方向另有 `*PatchSchema`，见那里的说明。
 */

/** 凭证的展示形态：只说有没有，绝不回显。 */
export const SecretPresenceSchema = z.object({
  /** 是否已配置（非空）。 */
  present: z.boolean(),
  /**
   * sha256 前 8 位。**仅供人眼比对「是不是我刚填的那个」**。
   *
   * 用指纹而不是长度：等长的两个 key 长度相同，于是「我改了没生效」这件事
   * 在界面上不可见。这与 `credentialFingerprint.ts` 对缓存键的要求同源，
   * 但**刻意不复用那个函数** —— 那是安全边界（决定是否重建连接），
   * 这里是展示用途，两者的取值范围要求不同（这里必须短到能显示）。
   * 未配置时为 null。
   */
  fingerprint: z.string().length(8).nullable(),
});
export type SecretPresence = z.infer<typeof SecretPresenceSchema>;

/**
 * Worker 的运行期视图 —— **配置 + 调度器状态合在一处**。
 *
 * 合并是这个端点存在的全部理由：`config.json` 知道「配了什么」，
 * `Scheduler` 知道「现在能不能用」，而用户问的那个问题
 * （「它为什么没在用我这个账号」）**必须两者一起才能回答**。
 * 先前 `npm run status` 只报进程信息、`doctor` 只能报配置形态，
 * 就是因为没有任何地方同时持有这两半。
 */
export const WorkerViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["anonymous", "authenticated"]),
  enabled: z.boolean(),
  /** 绑定的出口代理 id；null = 本机直连。 */
  proxyId: z.string().nullable(),
  apiKey: SecretPresenceSchema,
  /**
   * 是否在**调度器的候选池**里。
   *
   * 与 `enabled` 不同：认证 Worker 还要求 apiKey 非空；匿名 Worker 可以免 key。
   * 两种类型都要在界面上显示，不能把匿名 Worker 误报成“缺少 API key”。
   */
  inPool: z.boolean(),
  /**
   * 现在是否就绪（不在冷却中）。`inPool` 为假时恒为 false。
   *
   * 这是 Phase 8 的 `doctor` 明确报不了的那个字段（运行期状态住在服务进程里，
   * 进程外没有出口）—— 现在有了。
   */
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

/** 出口隔离分组。**按实测 IP 分组，不按代理 id** —— 见 `probe.ts`。 */
export const IsolationGroupViewSchema = z.object({
  egressIp: z.string(),
  workerIds: z.array(z.string()),
  proxyIds: z.array(z.string()),
});

export const IsolationViewSchema = z.object({
  groups: z.array(IsolationGroupViewSchema),
  /** 尚未探测出 IP 的 Worker。**不算作已隔离** —— 「还不知道」≠「确认不同」。 */
  unknownWorkerIds: z.array(z.string()),
  /** 存在共用出口的组。非空即隔离失败。 */
  sharedGroups: z.array(IsolationGroupViewSchema),
  isolated: z.boolean(),
});
export type IsolationView = z.infer<typeof IsolationViewSchema>;

/** 目录槽位状态。对应 `ModelCatalog.status()` —— 它此前没有生产读者。 */
export const CatalogSlotViewSchema = z.object({
  slot: z.enum(["keyless", "keyed"]),
  total: z.number().int().nonnegative(),
  ageMs: z.number().int().nonnegative(),
});

/**
 * Overview 页要的全部东西，一个请求给完。
 *
 * 刻意做成一个聚合端点而不是六个小端点：这一页的每个数字都来自**同一时刻**
 * 的状态，分六个请求拿会让「3 个 Worker / 2 个就绪 / 隔离成立」这三句话
 * 描述三个不同瞬间的系统 —— 而它们会被用户当成一句话读。
 */
export const OverviewSchema = z.object({
  health: HealthSchema,
  gateway: z.object({
    port: z.number().int(),
    baseUrl: z.string(),
    relayToken: SecretPresenceSchema,
    maxAttempts: z.number().int(),
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
    /** 当前身份下的免费模型数。拉不到目录时为 null（**不是 0**）。 */
    freeCount: z.number().int().nonnegative().nullable(),
  }),
  clash: z.object({
    enabled: z.boolean(),
    activeBridgeId: z.string().nullable(),
    bridges: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        enabled: z.boolean(),
        apiBase: z.string(),
        apiSecret: SecretPresenceSchema,
        localProxyPort: z.number().int(),
        selectorGroup: z.string(),
      }),
    ),
  }),
  /** 代理数量概览。完整列表在 ProxyPool 页（下一批）。 */
  proxies: z.object({
    total: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative(),
    withEgressIp: z.number().int().nonnegative(),
  }),
});
export type Overview = z.infer<typeof OverviewSchema>;

/**
 * 统计视图。对应 `StatsStore` 的四个聚合函数。
 *
 * `requests` 与 `attempts` **必须分开**：一条重试链是一个请求、多次尝试。
 * 这是 Phase 7 最容易被当成同一个的两个量。
 */
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
    /** null = 还没有带 usage 的请求（**不是 0%**）。 */
    cacheHitRate: z.number().nullable(),
    usageCoverage: z.number().nullable(),
    /** 非 0 说明**我们自己**没解析完整，要看界定常量而非上游。 */
    droppedUsageCount: z.number().int().nonnegative(),
  }),
  /** 网关自己拒掉的请求，按原因汇总。 */
  rejections: z.record(z.string(), z.number().int().nonnegative()),
});
export type StatsView = z.infer<typeof StatsViewSchema>;

/**
 * 管理面的错误体。
 *
 * **与转发面的 `gatewayError` 形状一致**（`{ error: { type, message } }`）——
 * 不是为了对齐 OpenAI，而是为了让 admin 只写一个错误解析函数。
 * 类型取值不同：管理面没有 `model_not_allowed` 这类转发概念。
 */
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
      "internal_error",
    ]),
    message: z.string(),
  }),
});
export type AdminError = z.infer<typeof AdminErrorSchema>;
/**
 * 错误类型的联合 —— 供 `adminError()` 的形参用。
 *
 * 先前 `routes/admin.ts` 手写了一份同样的五项联合，而这里的 `z.enum` 是
 * 同一事实的另一份副本（纪律 #4）。从 schema 推导让「加一种错误类型」
 * 只需要改一处，而漏改的方向是 typecheck 失败而不是运行期分叉。
 */
export type AdminErrorType = AdminError["error"]["type"];

/* ------------------------------------------------------------------ *
 * 写入方向（Phase 9）
 * ------------------------------------------------------------------ */

/**
 * ## 凭证字段的写入语义：三态，而且必须显式
 *
 * 一个凭证字段在 patch 里有三种意图，而**朴素的 optional 只能表达两种**：
 *
 * | 意图 | 表达 | 朴素 optional 的问题 |
 * |---|---|---|
 * | 不动它 | 字段缺席 | ✅ |
 * | 换成新值 | `{ set: "新值" }` | ✅ |
 * | **清空它** | `{ clear: true }` | ❌ 与「不动它」无法区分 |
 *
 * 若用 `apiKey?: string` 表达，那么 `apiKey: ""` 既可能是「用户想清空」
 * 也可能是「前端把未填的输入框原样提交了」—— 而后者会**静默清掉一个能用的
 * key**，然后那个 Worker 被 `isUsable()` 过滤掉、界面上看起来仍然 enabled。
 * 这正是「展示投影窄于存储」带来的必然后果：前端拿不到原值，就不能靠回传原值
 * 来表达「不动它」。
 *
 * 所以凭证一律用这个包装类型，**清空必须显式说出来**。
 */
export const SecretPatchSchema = z.union([
  z.strictObject({ set: z.string().max(512) }),
  z.strictObject({ clear: z.literal(true) }),
]);
export type SecretPatch = z.infer<typeof SecretPatchSchema>;

/**
 * Worker 的可改字段。
 *
 * 全部 optional —— 缺席即不动。`id` 不在这里：改 id 等于删旧建新，
 * 而那会丢掉调度器里累积的冷却状态（`#retired` 表按 id 索引），
 * 于是「改个名字」会顺带抹掉上游明确要求的 15 分钟等待。要换 id 就显式删建。
 */
export const WorkerPatchSchema = z.strictObject({
  kind: z.enum(["anonymous", "authenticated"]).optional(),
  name: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  /** null = 改为本机直连。缺席 = 不动。两者不同，所以用 nullable + optional。 */
  proxyId: z.string().nullable().optional(),
  apiKey: SecretPatchSchema.optional(),
});
export type WorkerPatch = z.infer<typeof WorkerPatchSchema>;

/**
 * 新建 Worker。
 *
 * 两种 Worker 都可以从管理面创建。认证 Worker 必须提供 API key；匿名 Worker
 * 可以留空，由上游按免鉴权请求处理。两者共享名称、启用状态和出口绑定能力。
 */
export const WorkerCreateSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:\-]+$/, { message: "id 只允许字母、数字与 . _ : - " }),
  name: z.string().max(200).default(""),
  kind: z.enum(["anonymous", "authenticated"]).optional(),
  apiKey: z.string().max(512).default(""),
  proxyId: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type WorkerCreate = z.infer<typeof WorkerCreateSchema>;

/** 网关设置的可改字段。`port` 不在这里 —— 改它要重启，属于 Gateway 页（下一批）。 */
export const GatewayPatchSchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  headersTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  bodyTimeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  relayToken: SecretPatchSchema.optional(),
});

/** 模型规则的可改字段。对应 Models 页（下一批做 UI，端点先立起来）。 */
export const ModelRulesPatchSchema = z.strictObject({
  freeSuffix: z.string().min(1).max(32).optional(),
  extraFreeIds: z.array(z.string().min(1).max(128)).max(256).optional(),
  catalogTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
  enforceCatalog: z.boolean().optional(),
});

/**
 * 配置补丁 —— 管理面写入的**唯一**入口形状。
 *
 * 做成一个顶层 patch 而不是每个资源一个端点：配置是**一个文件**，
 * 而 `saveConfig` 是整份原子写。多个端点各写一次会让「同时改两处」
 * 变成两次读-改-写，而那中间有一个丢失更新的窗口。
 *
 * `workers` 的三种操作分开表达（不是一个数组覆盖）：数组覆盖要求前端
 * 回传完整列表，而前端**拿不到 apiKey 的原值** —— 它只有 `present`，
 * 于是任何覆盖式写入都会抹掉所有 key。这是那条「投影窄于存储」的第二个后果。
 *
 * ## 补丁侧一律 `strictObject`（第十轮审核）
 *
 * `schema.ts` 每一层都是 `strictObject`，理由是「手工编辑是预期用法，拼错
 * 字段名必须立刻报错」。而这里先前用的是 `z.object`，于是**拼错的字段被
 * 静默丢弃**：`maxAttempt`（少个 s）、`freeSuffixes`、`workers.deletes`、
 * worker patch 里的 `enable` 实测全部"成功"，产出一个空 patch →
 * `applyConfigPatch` 返回 `changed: false` → 响应 `{"ok":true,"changed":false}`。
 *
 * 后果比手工编辑更糟：用户看到成功、刷新后值没变，而这正是 `patch.ts` 那条
 * 「不静默跳过 —— 静默跳过会让『我明明改了』变成一个查不出的问题」要防的
 * 情形，只是发生在更外一层。`workers.create` 是唯一能报错的，纯属巧合
 * （它有必填字段）。
 *
 * **响应侧的投影 schema 刻意保持 `z.object`**：那些对象由 `admin/project.ts`
 * 构造，多一个字段是我们自己的 bug 而不是用户输入的问题，而 strict 会让
 * 「加一个诊断字段」变成一次破坏性改动。
 */
export const ConfigPatchSchema = z.strictObject({
  gateway: GatewayPatchSchema.optional(),
  models: ModelRulesPatchSchema.optional(),
  workers: z
    .strictObject({
      create: z.array(WorkerCreateSchema).max(64).optional(),
      /** 按 id 定位；id 不存在则整个请求失败（`not_found`），不静默跳过。 */
      update: z.record(z.string(), WorkerPatchSchema).optional(),
      delete: z.array(z.string()).max(512).optional(),
    })
    .optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/* ------------------------------------------------------------------ *
 * 其余页面的视图（Phase 9 批次 2）
 * ------------------------------------------------------------------ */

/**
 * 代理的展示形态。
 *
 * `password` 换成 `SecretPresence`（代理口令是凭证）。其余字段原样 ——
 * `host`/`port`/`clashNodeName` 都是排查时要逐字符看的东西。
 */
export const ProxyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  host: z.string(),
  port: z.number().int(),
  enabled: z.boolean(),
  source: z.enum(["manual", "subscription", "controller"]),
  bridgeId: z.string().nullable(),
  clashNodeName: z.string().nullable(),
  direct: z.boolean(),
  bridgeable: z.boolean(),
  /** 最近一次**实测**的公网出口 IP。null = 未探测（**不是**「没有出口」）。 */
  egressIp: z.string().nullable(),
  password: SecretPresenceSchema,
  /**
   * 引用它的 Worker id。
   *
   * 由服务端算好而不是让前端 join：前端要按它显示「删掉这个代理会影响谁」，
   * 而那个判断若在前端做，两处（这里与 `patch.ts` 的引用完整性校验）
   * 就有两份实现，而分叉后界面会允许一个服务端必拒的操作。
   */
  usedBy: z.array(z.string()),
  /** 能否被解析成一条可用出口路径（纯本地判断）。 */
  resolvable: z.boolean(),
  /** 不可解析时的原因（已是人可读文案）。 */
  unresolvableReason: z.string().nullable(),
});
export type ProxyView = z.infer<typeof ProxyViewSchema>;

/** 模型的展示形态。免费判定的**依据**要能看到，否则「为什么这个不能用」没答案。 */
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

/**
 * 订阅的投影（Phase 10）。
 *
 * **URL 是凭证**（token 通常带在 query 或 path 里），所以这里**绝不**给原值
 * —— 只给一个脱敏后的展示串加一个"配没配"的标记，与 apiKey 同一条规则。
 * 少了这一条，一个订阅列表接口就等于把所有机场的付费凭证公开在回环上。
 */
export const SubscriptionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * 已脱敏的 URL —— 形如 `https://sub.example.com/link?token=***`。
   * 用户要能认出"这是哪个订阅"，但不该从界面上把 token 抄走。
   */
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
 * 一次出口探测的逐条结果（缺口 #25，第九轮补上）。
 *
 * ## 为什么这个端点也要有 schema
 *
 * 其余管理端点都是 `XxxSchema.parse(...)` + 由 `admin/project.ts` 构造，
 * 而 `POST /api/probe` 先前手工拼装 `ProbeOutcome` 的字段 —— 它是唯一
 * 绕过投影层与 schema 的管理响应。
 *
 * 今天不泄漏凭证（`reason` 来自 `safeErrorMessage`/`describeResolveFailure`，
 * 而 `probe.ts` 明确拒绝把响应正文放进 `reason`），**但那条纪律的全部价值
 * 在于"新增端点时漏掉一个字段没有任何症状"** —— 一个在纪律之外的端点
 * 恰好就是那种漏洞会出现的地方。
 *
 * `via` 是回显服务的 URL（`api.ipify.org` 这类），不是凭证 —— 它要能显示，
 * 因为「是不是某个回显服务挂了」只有它能回答。
 *
 * ## 为什么用 `strictObject`
 *
 * zod 默认的 `z.object` 对未知键是**剥掉**而不是拒绝 —— 那会让"往响应里
 * 多塞一个字段"静默通过（实测：加一个 `proxyPassword` 字段后 schema
 * 照常 parse，只是把它 strip 掉了）。剥掉确实挡住了泄漏，
 * 但**挡不住"下一个人以为自己加的字段生效了"** —— 他会去查为什么前端读不到。
 *
 * `strictObject` 让它在**构造响应时**就抛，与 `schema.ts` 里
 * 「全部用 strictObject，拼错字段名必须立刻报错」同一条理由。
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
  /** 出口隔离报告 —— 与 Overview 同一份逻辑，按实测 IP 分组。 */
  isolation: IsolationViewSchema,
  /** 订阅列表（Phase 10）—— 代理池页要能看到"这些节点从哪来"。 */
  subscriptions: z.array(SubscriptionViewSchema),
});
export type ProxyList = z.infer<typeof ProxyListSchema>;

export const ModelListSchema = z.object({
  /**
   * 在架目录里的全部模型（含付费的）—— Models 页要能回答
   * 「为什么这个模型不能用」，而那需要看到被拒的那些。
   *
   * 目录拿不到时是空数组，且 `catalogAvailable` 为 false ——
   * 「拿不到目录」与「目录里一个模型都没有」是两件事。
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

/** 批量探测进度 —— 形状与 `shared/batchProbe.ts` 的 `BatchProgress` 一致。 */
export const BatchProgressSchema = z.object({
  state: z.enum(["idle", "screening", "running", "paused", "cancelling", "done"]),
  screenTotal: z.number().int().nonnegative(),
  screenDone: z.number().int().nonnegative(),
  mainTotal: z.number().int().nonnegative(),
  mainDone: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  addedWorkerIds: z.array(z.string()),
  failureKind: z.string().nullable(),
  /**
   * 本批已跑多久（毫秒）。未开始过时为 null。
   *
   * 由服务端从 `started_at` 算 —— 前端算不了：它不知道这一批是什么时候
   * 开始的（刷新页面后内存里那份就没了，而进度本身归服务端所有）。
   *
   * 这也给了 `batch_probe_jobs.started_at` 第一个读者（缺口 #28）。
   * 先前它**建行之后永不更新**，于是第一次批测写下的值会存一辈子 ——
   * 没有读者所以不出症状，而那正是"死信息"的形态。
   */
  elapsedMs: z.number().int().nonnegative().nullable(),
});

/**
 * 批测进度的**线上形态** —— 比 reducer 的 `BatchProgress` 多一个 `elapsedMs`。
 *
 * 两者刻意不同：reducer 是纯函数，**没有时钟**，所以"已跑多久"不可能是
 * 它状态的一部分（那会让同一个状态在不同时刻不相等，穷举测试立刻失效）。
 * 耗时由服务端在**读**的时候算（`Date.now() - started_at`）。
 *
 * 前端用这个类型，不用 reducer 那个 —— 它拿到的是线上形态。
 */
export type BatchProgressView = z.infer<typeof BatchProgressSchema>;

/**
 * 前端的初始值 —— 线上形态的"从未跑过"。
 *
 * 不复用 reducer 的 `INITIAL`：那个少一个 `elapsedMs`（reducer 没有时钟）。
 * `elapsedMs: null` 而不是 0 —— 「没开始」与「刚开始」是两件事。
 */
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
