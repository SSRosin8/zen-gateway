import { Hono } from "hono";
import { OpenCodeViewSchema, OpenCodeWriteRequestSchema } from "../../../shared/contract.ts";
import { openCodeView, writeOpenCodeConfig, type OpenCodeContext } from "../../admin/opencode.ts";
import type { AdminDeps } from "../admin.ts";
import { adminError, readJsonBody } from "./common.ts";

/** 项目根 `opencode.json` 的状态与写入。响应只给状态，不含 token。 */
export function createOpenCodeRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  const context = (): OpenCodeContext | null =>
    deps.openCode === undefined
      ? null
      : {
          root: deps.openCode.root,
          probeVersion: deps.openCode.probeVersion,
          port: deps.effectivePort(),
          relayToken: deps.configOf().gateway.relayToken,
        };

  app.get("/opencode", async (c) => {
    const ctx = context();
    if (ctx === null) return adminError(c, "internal_error", "OpenCode 配置功能未装配");
    return c.json(OpenCodeViewSchema.parse(await openCodeView(ctx)));
  });

  app.post("/opencode/write", async (c) => {
    const body = await readJsonBody(c, OpenCodeWriteRequestSchema);
    if (!body.ok) return body.response;
    const ctx = context();
    if (ctx === null) return adminError(c, "internal_error", "OpenCode 配置功能未装配");

    const outcome = await writeOpenCodeConfig(ctx, body.data.version !== undefined ? { version: body.data.version } : {});
    if (!outcome.ok) return adminError(c, "invalid_config", `opencode.json 未写入:${outcome.reason}`);
    deps.log?.(`opencode.json 已${outcome.action === "created" ? "创建" : "更新"}`);
    return c.json(OpenCodeViewSchema.parse(await openCodeView(ctx)));
  });

  return app;
}
