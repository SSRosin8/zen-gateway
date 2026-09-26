import { Hono } from "hono";
import {
  ClashDiscoverRequestSchema,
  ClashDiscoverResponseSchema,
  ClashImportRequestSchema,
  ClashImportResponseSchema,
  type ClashControllerView,
} from "../../../shared/contract.ts";
import {
  discoverControllers,
  isLocalControllerUrl,
  mergeControllerImport,
  planController,
} from "../../../core/proxy/clash/setupImport.ts";
import { safeErrorMessage } from "../../../shared/redact.ts";
import type { AdminDeps } from "../admin.ts";
import { adminError, readJsonBody } from "./common.ts";

/**
 * Clash 发现与导入，逻辑与 `npm run setup` 共用 `setupImport.ts`。显式地址必须是本机 http
 * 回环：请求体里的 secret 会被发往那个地址。响应不回显 secret。
 */
export function createClashRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  app.post("/clash/discover", async (c) => {
    const body = await readJsonBody(c, ClashDiscoverRequestSchema);
    if (!body.ok) return body.response;
    const { apiBase, secret } = body.data;
    if (apiBase !== undefined && !isLocalControllerUrl(apiBase)) {
      return adminError(c, "invalid_request", "apiBase: 必须是本机 http 回环地址(不含凭证、query 与 fragment)");
    }

    const { results } = await discoverControllers({
      ...(apiBase !== undefined ? { explicitApi: apiBase } : {}),
      ...(secret !== undefined ? { secret } : {}),
      knownSecrets: deps.configOf().clash.bridges.map((b) => b.apiSecret),
    });

    const controllers: ClashControllerView[] = [];
    for (const r of results) {
      if (r.kind === "auth") {
        controllers.push({ apiBase: r.apiBase, status: "auth_required", reason: "Controller 要求 secret" });
        continue;
      }
      if (r.kind === "absent") {
        // 未指定地址时，白名单里没人监听的端口不列出，只在一个都没有时由前端提示。
        if (apiBase !== undefined) controllers.push({ apiBase: r.apiBase, status: "unreachable", reason: r.why });
        continue;
      }
      const plan = await planController(r);
      controllers.push(
        plan.ok
          ? {
              apiBase: r.apiBase,
              status: "ok",
              version: `${r.isMeta ? "mihomo" : "clash"} ${r.version}`,
              mode: plan.plan.mode,
              mixedPort: plan.plan.mixedPort,
              selectorGroup: plan.plan.selector.name,
              nodeCount: plan.plan.usable,
              ...(plan.plan.warnings.length > 0 ? { reason: plan.plan.warnings.join("; ") } : {}),
            }
          : { apiBase: r.apiBase, status: "ok", version: `${r.isMeta ? "mihomo" : "clash"} ${r.version}`, reason: plan.reason },
      );
    }
    return c.json(ClashDiscoverResponseSchema.parse({ controllers }));
  });

  app.post("/clash/import", async (c) => {
    const body = await readJsonBody(c, ClashImportRequestSchema);
    if (!body.ok) return body.response;
    const { apiBase, dryRun } = body.data;
    if (!isLocalControllerUrl(apiBase)) {
      return adminError(c, "invalid_request", "apiBase: 必须是本机 http 回环地址(不含凭证、query 与 fragment)");
    }

    // 先用给定 secret（或免 secret），要鉴权时再试已配置内核的 secret，与发现同一规则。
    const { results } = await discoverControllers({
      explicitApi: apiBase,
      ...(body.data.secret !== undefined ? { secret: body.data.secret } : {}),
      knownSecrets: deps.configOf().clash.bridges.map((b) => b.apiSecret),
    });
    const probe = results[0]!;
    if (probe.kind === "auth") return adminError(c, "auth_required", "Controller 要求 secret,或给出的 secret 不对");
    if (probe.kind === "absent") return adminError(c, "invalid_request", `无法连接 Controller:${probe.why}`);

    const planned = await planController(probe);
    if (!planned.ok) {
      return adminError(c, "invalid_config", planned.detail === undefined ? planned.reason : `${planned.reason}:${planned.detail}`);
    }

    // 合并基于最新配置：发现与读取节点耗时数秒，期间用户可能改过配置。
    const fresh = deps.configOf();
    const merged = mergeControllerImport(fresh, [planned.plan]);
    if (!merged.ok) return adminError(c, "invalid_config", `合并后的配置不合法:${merged.reason}`);

    if (!dryRun) {
      try {
        await deps.applyConfig(merged.next, fresh);
      } catch (err) {
        deps.log?.(`Clash 导入写入失败: ${safeErrorMessage(err)}`);
        return adminError(c, "write_failed", `导入写入失败:${safeErrorMessage(err)}`);
      }
      deps.log?.(`Clash 导入(${apiBase}): +${merged.summary.proxiesAdded} ~${merged.summary.proxiesUpdated}`);
    }

    return c.json(
      ClashImportResponseSchema.parse({
        ok: true,
        dryRun,
        summary: {
          bridgesAdded: merged.summary.bridgesAdded,
          bridgesUpdated: merged.summary.bridgesUpdated,
          proxiesAdded: merged.summary.proxiesAdded,
          proxiesUpdated: merged.summary.proxiesUpdated,
          selectorGroup: planned.plan.selector.name,
          mixedPort: planned.plan.mixedPort,
          warnings: [...planned.plan.warnings, ...merged.summary.warnings],
        },
      }),
    );
  });

  return app;
}
