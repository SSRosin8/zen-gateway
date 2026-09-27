import { Hono } from "hono";
import { DiagnosticsSchema } from "../../../shared/contract.ts";
import { runDiagnostics } from "../../admin/diagnostics.ts";
import type { AdminDeps } from "../admin.ts";

/** 进程内分层诊断（替代服务在跑时的 `npm run doctor`）。回显出口实测走 `POST /api/probe`。 */
export function createDiagnosticsRoutes(deps: AdminDeps): Hono {
  const app = new Hono();

  app.get("/diagnostics", async (c) => {
    const layers = await runDiagnostics({
      config: deps.configOf(),
      runtime: deps.runtimeWorkers(),
      health: deps.health(),
      statsAvailable: deps.stats !== undefined,
      ...(deps.diskConfigCheck !== undefined ? { diskConfigCheck: deps.diskConfigCheck } : {}),
      ...(deps.ensureCatalog !== undefined ? { ensureCatalog: deps.ensureCatalog } : {}),
      env: process.env,
    });
    return c.json(DiagnosticsSchema.parse({ layers }));
  });

  return app;
}
