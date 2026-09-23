import { Hono } from "hono";
import { HealthSchema } from "../shared/contract.ts";
import type { Config } from "../shared/schema.ts";
import { ProtocolRegistry } from "../core/protocols/registry.ts";
import { chatSurface, MODELS_PATHS } from "../core/protocols/chat.ts";
import { responsesSurface } from "../core/protocols/responses.ts";
import { messagesSurface } from "../core/protocols/messages.ts";
import { EgressService } from "../core/proxy/egress.ts";
import { Scheduler } from "../core/routing/scheduler.ts";
import { ModelCatalog } from "../core/models/catalog.ts";
import { relayAuth } from "./middleware/relayAuth.ts";
import { loopbackOnly } from "./middleware/loopbackOnly.ts";
import { createRelayRoutes } from "./routes/relay.ts";
import { createModelsRoutes } from "./routes/models.ts";

const STARTED_AT = Date.now();
export const VERSION = "0.1.0";

/**
 * 应用装配。
 *
 * ## 注册表在这里建立,面在这里注册 —— 且仅此一处
 *
 * 规划对这个抽象的验收条件是「新增一个面 = 加一个文件 + 注册一行,**不动**
 * 路由装配、鉴权、免费判定、重试、透传」。
 *
 * **Phase 6 兑现了它**:加 `responses` 与 `messages` 时,`src/server/` 下
 * 唯一的改动就是下面那两行 `.register(...)`。路由(`registry.paths()` 动态
 * 挂载)、鉴权守卫(同源推导)、调度、重试、透传都**一行未改** ——
 * 而第四轮审核时守卫还是手写的三条路径字面量,那时加这两个面会让
 * `/responses`、`/messages` 两条无前缀别名成为免鉴权中继。
 *
 * 两个面各自带来的新东西不在装配层:`responses` 让「体内会话指针优先于头」
 * 那条接线第一次真的可执行,`messages` 需要把 key 镜像到 `x-api-key`
 * (否则上游 500 → 整池 Worker 被冷却)。两者都由**面自己**表达。
 *
 * ## 为什么把 registry 做成参数可注入
 *
 * 测试要能只注册一个假面来验证路由分派,而不必连带真实的 chat 面。
 * 更要紧的是:注册表的**冲突检查**要能被测试直接驱动(两个面抢同一路径),
 * 而那需要能构造出冲突的注册表。
 */
export function buildRegistry(): ProtocolRegistry {
  return new ProtocolRegistry()
    .register(chatSurface)
    .register(responsesSurface)
    .register(messagesSurface);
}

export type AppDeps = {
  /**
   * 读当前配置。
   *
   * 做成函数而非值:配置热更新后下一个请求就该用新值,
   * 而不是等重启。Relay Token 与 baseUrl 都可能被改。
   */
  readonly configOf: () => Config;
  readonly registry?: ProtocolRegistry;
  /** 出口服务。转发与探测必须共用同一个 —— 见 EgressService.upstreamDeps。 */
  readonly egress: EgressService;
  /**
   * 调度器。不传则建一个 —— 但**每个 app 只能有一个**。
   *
   * 与 egress 同理:两份冷却状态会让「这个 Worker 在冷却」取决于请求碰巧
   * 走到哪一份,而冷却存在的理由正是别再打那个上游。可注入是为了让测试
   * 能持有同一个实例来断言跨请求的状态(冷却生效、粘滞命中)。
   */
  readonly scheduler?: Scheduler;
  /**
   * 在架目录缓存。不传则建一个 —— 但**每个 app 只能有一个**。
   *
   * 与 scheduler 同理:两份缓存会让"这个模型在不在架"取决于请求走到哪一份,
   * 而且会把上游目录请求数翻倍。可注入是为了让测试预置一份目录,
   * 免得每个转发测试都要去打上游。
   */
  readonly catalog?: ModelCatalog;
  readonly newId?: () => string;
  /** 注入以便测试推进时间。 */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
};

export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    // 走一遍 schema：契约变了这里立刻 typecheck 失败,而不是让 admin 在运行期发现。
    const body = HealthSchema.parse({
      ok: true,
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
      // service.mjs 靠这个验明进程身份,决定能否安全发送 SIGTERM。
      pid: process.pid,
    });
    return c.json(body);
  });

  /*
   * 没有依赖时只提供 /health。
   *
   * service.mjs 的健康等待只需要 /health,而 Phase 0-2 的集成测试正是这么用的。
   * 保留这条路径让「启动一个只有健康检查的服务」仍然可能 ——
   * 但转发面绝不会在没有配置的情况下悄悄以某个默认值工作。
   */
  if (deps === undefined) return app;

  const registry = deps.registry ?? buildRegistry();
  const upstreamOf = (config: Config) => deps.egress.upstreamDeps(config);
  /*
   * 目录缓存在进程内唯一 —— 见 AppDeps.catalog。
   *
   * 刻意**不**在这里预热:`createApp` 是同步的,而预热要发网络请求。
   * 预热放在 `server/index.ts`(它本来就是 async),于是测试里建 app
   * 不会顺带打一次上游 —— 那种隐式网络依赖会让单测偶发失败。
   */
  const catalog =
    deps.catalog ??
    new ModelCatalog({
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    });

  /*
   * 转发面:先鉴权,再进路由。
   *
   * ## 守卫的挂载点必须从注册表推导,不能手写
   *
   * 路由本身是 `registry.paths()` 动态挂载的（见 `routes/relay.ts`）,所以
   * 注册表是"有哪些路径"的唯一真相。守卫若另写一份人工名单,两份就会脱节,
   * 而**脱节的方向必然是漏**:新增协议面时路由自动出现,守卫却不会。
   *
   * 这不是假想。先前这里写的是 `/v1/*` + `/chat/*` + `/models` 三条字面量,
   * 独立审核按本文件注释自己承诺的 Phase 6 形态注册 `responses`/`messages`
   * 之后实测:`/v1/responses` 与 `/v1/messages` 有鉴权,而**无前缀别名
   * `/responses`、`/messages` 完全绕过** —— 成为本机任意进程可用的、
   * 消耗用户 Worker key 的免鉴权中继。原注释还断言"用路径匹配而不是逐条挂载,
   * 因为逐条挂载会在新增面时被漏掉",恰好说反了:通配前缀匹配才是漏的那个,
   * 因为它只覆盖它恰好写到的那几个前缀。
   *
   * 现在改为逐条精确挂载,来源与路由同一个 —— 加一个面就自动多一道守卫,
   * 结构上不可能漏。下面那条断言是最后一道保险。
   */
  const relayGuard = relayAuth({ tokenOf: () => deps.configOf().gateway.relayToken });

  const guardedPaths = [...registry.paths(), ...MODELS_PATHS];
  for (const path of guardedPaths) {
    // 精确路径,不用通配 —— 通配的覆盖范围与注册表无关,正是上面那个 bug 的成因。
    app.use(path, relayGuard);
  }

  const relayDeps = {
    configOf: deps.configOf,
    registry,
    upstreamOf,
    scheduler: deps.scheduler ?? new Scheduler(),
    catalog,
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };

  app.route("/", createRelayRoutes(relayDeps));
  app.route(
    "/",
    createModelsRoutes({
      configOf: deps.configOf,
      upstreamOf,
      catalog,
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    }),
  );

  /*
   * 管理面:仅回环。
   *
   * Phase 9 才有真正的管理 API,这里先把闸门装上并挂一个探针端点 ——
   * 好让「管理面仅回环」这条安全要求从现在起就有测试守着,
   * 而不是等到 Phase 9 再补(那时它会变成一条容易被漏掉的待办)。
   */
  const admin = new Hono();
  admin.use("/*", loopbackOnly());
  admin.get("/ping", (c) => c.json({ ok: true }));
  app.route("/api", admin);

  assertEveryRouteGuarded(app);

  return app;
}

/**
 * 启动期断言:每条路由都有守卫。
 *
 * 上面那套「守卫挂载点从注册表推导」已经让漏守卫**不容易**发生,但"不容易"
 * 不是"不可能" —— 将来某个 `app.get(...)` 被直接加进来（Phase 9 的管理 API、
 * 某个调试端点）就又会出现一条裸路由,而那种错误**不会有任何症状**,
 * 只是安静地对本机所有进程开放。
 *
 * 所以这里把它做成断言而不是约定:Hono 的 `app.routes` 里中间件登记为
 * `ALL`、处理器登记为具体方法,据此可以核对每条处理器路径是否被某条中间件
 * 覆盖。构造期抛错 —— 服务起不来远好于静默敞开。
 *
 * 这条断言本身也要能失败:见 `tests/integration/relay.test.ts` 里对它做的
 * 变异测试（把守卫改回通配挂载后,它必须抛错）。
 */
function assertEveryRouteGuarded(app: Hono): void {
  /*
   * `/health` 故意免鉴权:service.mjs 的健康等待与 doctor 都靠它,
   * 而它只回报 ok/version/uptime/pid,不含任何配置或凭证。
   */
  const EXEMPT = new Set(["/health"]);

  const middlewarePaths = app.routes.filter((r) => r.method === "ALL").map((r) => r.path);
  const unguarded: string[] = [];

  for (const route of app.routes) {
    if (route.method === "ALL") continue; // 这是中间件,不是处理器
    if (EXEMPT.has(route.path)) continue;

    const covered = middlewarePaths.some((mw) => {
      if (mw === route.path) return true;
      // 通配前缀:`/api/*` 覆盖 `/api/ping`。
      if (mw.endsWith("/*")) return route.path.startsWith(mw.slice(0, -1));
      return false;
    });
    if (!covered) unguarded.push(`${route.method} ${route.path}`);
  }

  if (unguarded.length > 0) {
    throw new Error(
      `装配错误:以下路由没有任何守卫中间件覆盖,会对本机所有进程开放:\n` +
        unguarded.map((r) => `  - ${r}`).join("\n") +
        `\n若某条路由确实应当免鉴权,请显式加入 assertEveryRouteGuarded 的 EXEMPT 并说明理由。`,
    );
  }
}
