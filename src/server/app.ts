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
import { isLoopbackGuard, loopbackOnly } from "./middleware/loopbackOnly.ts";
import { createRelayRoutes, type StatsSink } from "./routes/relay.ts";
import { createModelsRoutes } from "./routes/models.ts";
import { createAdminRoutes, type AdminDeps } from "./routes/admin.ts";

const STARTED_AT = Date.now();
export const VERSION = "0.1.0";

/**
 * 健康体的唯一构造点，`/health` 与 `/api/overview` 共用（纪律 #4）。过 schema 以便契约变化立刻失败。
 */
export function buildHealth(storeWriteFailures: number) {
  return HealthSchema.parse({
    ok: true,
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    // service.mjs 靠这个验明进程身份,决定能否安全发送 SIGTERM。
    pid: process.pid,
    // 非 0 说明统计库有问题，报表数字不可信 —— 见 contract 里的说明。
    storeWriteFailures,
  });
}

/**
 * 注册表在这里建立、面在这里注册，且仅此一处：新增一个面 = 加一个文件 + 注册一行，
 * 路由、鉴权守卫、调度、重试、透传都从注册表推导，不因新面改动。
 * 各面的特殊行为（会话指针、`x-api-key` 镜像）由面自己表达。registry 可注入以便测试冲突检查。
 */
export function buildRegistry(): ProtocolRegistry {
  return new ProtocolRegistry()
    .register(chatSurface)
    .register(responsesSurface)
    .register(messagesSurface);
}

export type AppDeps = {
  /** 读当前配置；做成函数以便热更新后下一个请求就用新值。 */
  readonly configOf: () => Config;
  readonly registry?: ProtocolRegistry;
  /** 出口服务。转发与探测必须共用同一个 —— 见 EgressService.upstreamDeps。 */
  readonly egress: EgressService;
  /** 调度器；不传则建一个，但每个 app 只能有一个（两份冷却状态会分叉）。可注入以便测试断言跨请求状态。 */
  readonly scheduler?: Scheduler;
  /** 在架目录缓存；不传则建一个，每个 app 唯一。可注入以便测试预置目录。 */
  readonly catalog?: ModelCatalog;
  readonly newId?: () => string;
  /** 注入以便测试推进时间。 */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
  /** 统计写入；不传则不记。需要打开的数据库，所以不在这里兜底，由 `index.ts` 注入。 */
  readonly stats?: StatsSink;
  /** 统计/持久化的累计写失败数，供 `/health` 报出；由同时持有两个 store 的 `index.ts` 提供。 */
  readonly storeWriteFailures?: () => number;
  /** 管理 API；不传则 `/api` 只有 `/ping`。需要写配置能力，不在装配层兜底，由 `index.ts` 注入。 */
  readonly admin?: AdminDeps;
  /**
   * 仅供测试：覆盖对端地址的来源。`app.request()` 没有真 socket，否则管理面在测试里恒为 403。
   * 只替换「地址从哪来」，不替换「怎么判断」；判定逻辑由 `tests/unit/middleware.test.ts` 用真实实现验证。
   */
  readonly addressOf?: (c: import("hono").Context) => string | undefined;
};

export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json(buildHealth(deps?.storeWriteFailures?.() ?? 0)));

  // 没有依赖时只提供 /health（service.mjs 的健康等待与部分测试只要它），转发面不会以默认值悄悄工作。
  if (deps === undefined) return app;

  const registry = deps.registry ?? buildRegistry();
  const upstreamOf = (config: Config) => deps.egress.upstreamDeps(config);
  // 目录缓存进程内唯一。不在这里预热（要发网络请求），预热在 `index.ts`，测试建 app 不会打上游。
  const catalog =
    deps.catalog ??
    new ModelCatalog({
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    });

  /*
   * 转发面守卫的挂载点从注册表推导，逐条精确挂载（纪律 #4）：
   * 手写 `/v1/*` 之类的通配前缀会漏掉无前缀别名（`/responses`、`/messages`），
   * 让它们成为免鉴权中继。下面的断言是最后一道保险。
   */
  const tokenOf = () => deps.configOf().gateway.relayToken;
  const relayGuard = relayAuth({ tokenOf });
  // 接受 `x-api-key` 的能力从面的声明推导,与挂载路径同源。
  const apiKeyGuard = relayAuth({ tokenOf, acceptApiKeyHeader: true });

  const guardedPaths = [...registry.paths(), ...MODELS_PATHS];
  for (const path of guardedPaths) {
    // 精确路径,不用通配：通配的覆盖范围与注册表无关。
    app.use(path, registry.byPath(path)?.acceptsApiKeyHeader === true ? apiKeyGuard : relayGuard);
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
    ...(deps.stats !== undefined ? { stats: deps.stats } : {}),
  };

  app.route("/", createRelayRoutes(relayDeps));
  app.route("/", createModelsRoutes({ configOf: deps.configOf, upstreamOf, catalog }));

  /*
   * 管理面仅回环。这里用 `/*` 通配是对的：管理面的规则是「全部」，
   * 转发面的规则是「注册表里那些」，只有后者需要从真相推导。
   */
  const admin = new Hono();
  admin.use("/*", loopbackOnly(deps.addressOf !== undefined ? { addressOf: deps.addressOf } : {}));
  if (deps.admin !== undefined) {
    admin.route("/", createAdminRoutes(deps.admin));
  } else {
    admin.get("/ping", (c) => c.json({ ok: true }));
  }
  app.route("/api", admin);

  assertEveryRouteGuarded(app);
  assertAdminRoutesLoopbackOnly(app);

  return app;
}

/** 路由是否被某条中间件路径覆盖：精确相同，或通配前缀（`/api/*` 覆盖 `/api/ping`）。 */
function coveredBy(middlewarePaths: readonly string[], path: string): boolean {
  return middlewarePaths.some((mw) => mw === path || (mw.endsWith("/*") && path.startsWith(mw.slice(0, -1))));
}

/**
 * 启动期断言：每条处理器路由都被某条中间件（Hono 登记为 `ALL`）覆盖，构造期抛错好过静默敞开。
 * 导出仅为可测：测试喂一个故意装错的 app 进来（见 `tests/unit/middleware.test.ts`）。
 */
export function assertEveryRouteGuarded(app: Hono): void {
  // `/health` 故意免鉴权：service.mjs 与 doctor 依赖它，且它不含配置或凭证。
  const EXEMPT = new Set(["/health"]);

  const middlewarePaths = app.routes.filter((r) => r.method === "ALL").map((r) => r.path);
  const unguarded: string[] = [];

  for (const route of app.routes) {
    if (route.method === "ALL") continue; // 这是中间件,不是处理器
    if (EXEMPT.has(route.path)) continue;

    if (!coveredBy(middlewarePaths, route.path)) unguarded.push(`${route.method} ${route.path}`);
  }

  if (unguarded.length > 0) {
    throw new Error(
      `装配错误:以下路由没有任何守卫中间件覆盖,会对本机所有进程开放:\n` +
        unguarded.map((r) => `  - ${r}`).join("\n") +
        `\n若某条路由确实应当免鉴权,请显式加入 assertEveryRouteGuarded 的 EXEMPT 并说明理由。`,
    );
  }
}

/**
 * 启动期断言：`/api/*` 下每条路由都被 loopbackOnly 覆盖。`assertEveryRouteGuarded` 只查有无守卫，
 * 而管理面不设 Relay Token，「仅本机」是唯一保护。按中间件身份（`isLoopbackGuard`）而非路径形状判定。
 * 导出仅为可测，同上。
 */
export function assertAdminRoutesLoopbackOnly(app: Hono): void {
  const loopbackPaths = app.routes
    .filter((r) => r.method === "ALL" && isLoopbackGuard(r.handler))
    .map((r) => r.path);

  const unprotected: string[] = [];
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    if (!route.path.startsWith("/api")) continue;

    if (!coveredBy(loopbackPaths, route.path)) unprotected.push(`${route.method} ${route.path}`);
  }

  if (unprotected.length > 0) {
    throw new Error(
      `装配错误:以下管理路由没有被 loopbackOnly 覆盖,会接受远端请求:\n` +
        unprotected.map((r) => `  - ${r}`).join("\n") +
        `\n管理面不设 Relay Token,「仅本机」是它唯一的保护。`,
    );
  }
}
