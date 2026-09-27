import { Hono } from "hono";
import { DiagnosticsSchema } from "../../../shared/contract.ts";
import { runDiagnostics } from "../../admin/diagnostics.ts";
import type { AdminDeps } from "../admin.ts";
import { probeExclusive } from "./probe.ts";

/** 进程内分层诊断（替代服务在跑时的 `npm run doctor`）与深度出口探测。 */
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

  /**
   * 深度诊断 = 回显出口实测，与 `POST /api/probe` 同一条路径。会切 Clash selector，
   * 所以与批量探测互斥：批测进行中回 409，运行期间批测也无法启动。
   */
  app.post("/diagnostics/deep", async (c) => await probeExclusive(c, deps));

  return app;
}
