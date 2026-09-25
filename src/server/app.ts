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
 * 健康体的**唯一**构造点。
 *
 * `/health` 与 `/api/overview` 都要它，而两处各拼一份会分叉（纪律 #4）——
 * 分叉方向是漏：加一个字段时管理面那份不会更新，于是后台显示的健康信息
 * 比 `/health` 旧一个版本，而那种偏差没有任何症状。
 *
 * 走一遍 schema：契约变了这里立刻 typecheck 失败，而不是让 admin 在运行期发现。
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
  /**
   * 统计写入（Phase 7）。不传则不记统计 —— 转发行为完全不变。
   *
   * 与 scheduler/catalog 不同,这个**不在这里兜底 new 一个**:
   * 它需要一个打开的数据库,而"装配层顺手开个库"会让每个测试都落盘。
   * 由 `index.ts` 显式注入。
   */
  readonly stats?: StatsSink;
  /**
   * 统计/持久化的累计写失败数，供 `/health` 报出。
   *
   * 由 `index.ts` 提供 —— 它是唯一同时持有两个 store 引用的地方
   * （`affinityStore` 被塞进 `Scheduler` 后拿不出来）。不传则报 0。
   */
  readonly storeWriteFailures?: () => number;
  /**
   * 管理 API（Phase 9）。不传则 `/api` 只有 `/ping`。
   *
   * 与 `stats` 同理**不在这里兜底造一个**：它需要配置写入能力与调度器的
   * 运行期状态，而「装配层顺手造一个写盘函数」会让每个测试都能改真实配置。
   * 由 `index.ts` 显式注入。
   */
  readonly admin?: AdminDeps;
  /**
   * 覆盖「对端地址怎么取」—— **仅供测试**。
   *
   * 生产路径走 `getConnInfo(c).remote.address`（内核报告的 TCP 对端地址，
   * 唯一可信的来源证据）。但集成测试需要驱动真实装配下的管理 API，
   * 而 `app.request()` 起不了真 socket，`getConnInfo` 因此拿不到地址 →
   * 一律判否（默认拒绝）→ 所有管理端点在测试里恒为 403，**整套 API
   * 无从验证**。
   *
   * 这不是给生产开的后门:`loopbackOnly` 的默认实现没变,注入点在装配层,
   * 而 `index.ts` 从不传它。第四轮审核查出过一个反例(回环测试注入
   * `addressOf` 而被替换掉的**正是**要测的那段),所以这里要说清分工:
   * 判定逻辑(`isLoopbackAddress`，含 IPv4-mapped IPv6 与 `127.0.0.0/8`)
   * 由 `tests/unit/middleware.test.ts` 用真实实现穷举验证;
   * 本注入只替换「地址从哪来」,不替换「怎么判断」。
   */
  readonly addressOf?: (c: import("hono").Context) => string | undefined;
};

export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json(buildHealth(deps?.storeWriteFailures?.() ?? 0)));

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
    ...(deps.stats !== undefined ? { stats: deps.stats } : {}),
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
   * Phase 9 起这里有真正的管理 API（`/api/overview`、`/api/stats`、
   * `PATCH /api/config`）。`/ping` 保留 —— 它是「管理面仅回环」这条约束
   * 最小的验证目标，且 `assertEveryRouteGuarded` 的变异测试依赖它。
   *
   * `loopbackOnly` 挂在 `/*` 上:管理面**任何**路由都不该接受远端,
   * 所以这里用通配是对的 —— 与转发面相反(那里通配会漏,因为覆盖范围
   * 与注册表无关)。差别在于:管理面的规则是「全部」,转发面的规则是
   * 「注册表里那些」,而只有后者需要从真相推导。
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
 * **导出仅为可测。** 这里先前写着「见 `tests/integration/relay.test.ts` 里对它
 * 做的变异测试」,而第十轮审核实测**那个测试不存在** —— 在本函数首行插一句
 * `return` 之后全量测试依然全绿。唯一碰到它的是 `auditRound4.test.ts` 对一个
 * **正确**的 app 断言 `.not.toThrow()`,那只能发现误报,永远发现不了
 * 「断言被阉掉」。**一条指向不存在的测试的注释比没有注释更糟**:它让下一个人
 * 以为这里有守卫。
 *
 * 这与隔壁 `assertAdminRoutesLoopbackOnly` 是同一个洞 —— 第八轮在那条上查出
 * 并修好了,而没有把同一手法应用到这条（纪律 #4 的注释版:正确的修法就在
 * 邻居函数里）。现在测试会喂一个故意装错的 app 进来,见
 * `tests/unit/middleware.test.ts`。
 */
export function assertEveryRouteGuarded(app: Hono): void {
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

/**
 * 启动期断言:`/api/*` 下的每条路由都被 **loopbackOnly** 覆盖。
 *
 * ## 为什么上面那条断言不够（缺口 #8 到期）
 *
 * `assertEveryRouteGuarded` 只检查「有没有守卫」，不检查「是哪个」——
 * 一条只挂了 `relayAuth` 而没挂 `loopbackOnly` 的管理路由能通过它。
 * 第四轮审核查出的那个缺陷（无前缀别名绕过鉴权）的变体就是这个形态，
 * 而 Phase 9 加管理 API 正是它变成活缺陷的时刻：管理面不设 Relay Token
 * （那是转发面的凭证），它唯一的保护就是「仅本机」。
 *
 * 判据用中间件的**身份**而不是路径形状：`loopbackOnly()` 返回的处理器带
 * 一个标记（见那个文件），据此可以区分它与其他中间件。只比路径的话，
 * 「`/api/*` 上挂了某个中间件」并不能说明挂的是回环闸门。
 *
 * 构造期抛错 —— 服务起不来远好于管理面静默对外开放。
 *
 * **导出仅为可测。** 第八轮审核实测:在本函数首行插一句 `return` 之后
 * 全套测试**依然全绿** —— 唯一碰到它的测试是对一个**正确**的 app 断言
 * `.not.toThrow()`,那只能发现误报,永远发现不了「断言被阉掉」。
 * 于是这条声称已关闭缺口 #8 的守卫,自己没有任何东西守着。
 * 现在测试会喂一个故意装错的 app 进来（见 `tests/unit/middleware.test.ts`）。
 */
export function assertAdminRoutesLoopbackOnly(app: Hono): void {
  const loopbackPaths = app.routes
    .filter((r) => r.method === "ALL" && isLoopbackGuard(r.handler))
    .map((r) => r.path);

  const unprotected: string[] = [];
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    if (!route.path.startsWith("/api")) continue;

    const covered = loopbackPaths.some((mw) => {
      if (mw === route.path) return true;
      if (mw.endsWith("/*")) return route.path.startsWith(mw.slice(0, -1));
      return false;
    });
    if (!covered) unprotected.push(`${route.method} ${route.path}`);
  }

  if (unprotected.length > 0) {
    throw new Error(
      `装配错误:以下管理路由没有被 loopbackOnly 覆盖,会接受远端请求:\n` +
        unprotected.map((r) => `  - ${r}`).join("\n") +
        `\n管理面不设 Relay Token,「仅本机」是它唯一的保护。`,
    );
  }
}
