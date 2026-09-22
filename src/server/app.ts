import { Hono } from "hono";
import { HealthSchema } from "../shared/contract.ts";

const STARTED_AT = Date.now();
export const VERSION = "0.1.0";

export function createApp(): Hono {
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

  return app;
}
