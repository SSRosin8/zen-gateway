import { Hono } from "hono";
import { HealthSchema } from "../shared/contract.ts";
import type { Config } from "../shared/schema.ts";
import { ProtocolRegistry } from "../core/protocols/registry.ts";
import { chatSurface } from "../core/protocols/chat.ts";
import { EgressService } from "../core/proxy/egress.ts";
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
 * Phase 6 新增 `responses` 与 `messages` 时,**唯一**需要改的是下面
 * `buildRegistry()` 里的注册行。路由装配、鉴权、免费判定、重试、透传
 * 都不该因为多一个面而改动 —— 那是规划里对这个抽象的验收条件。
 *
 * ## 为什么把 registry 做成参数可注入
 *
 * 测试要能只注册一个假面来验证路由分派,而不必连带真实的 chat 面。
 * 更要紧的是:注册表的**冲突检查**要能被测试直接驱动(两个面抢同一路径),
 * 而那需要能构造出冲突的注册表。
 */
export function buildRegistry(): ProtocolRegistry {
  return new ProtocolRegistry().register(chatSurface);
  // Phase 6: .register(responsesSurface).register(messagesSurface)
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
  readonly newId?: () => string;
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
   * 转发面:先鉴权,再进路由。
   *
   * `relayAuth` 挂在 `/v1/*` 与无前缀别名上 —— 两组路径都要护住,
   * 漏一组等于留了个免鉴权的后门。这里用中间件路径匹配而不是逐条挂载,
   * 因为逐条挂载会在新增协议面时被漏掉,而漏掉的后果是静默失去鉴权。
   */
  const relayGuard = relayAuth({ tokenOf: () => deps.configOf().gateway.relayToken });
  app.use("/v1/*", relayGuard);
  app.use("/chat/*", relayGuard);
  app.use("/models", relayGuard);

  const relayDeps = {
    configOf: deps.configOf,
    registry,
    upstreamOf,
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };

  app.route("/", createRelayRoutes(relayDeps));
  app.route(
    "/",
    createModelsRoutes({
      configOf: deps.configOf,
      upstreamOf,
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

  return app;
}
