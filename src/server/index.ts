import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const PORT = Number(process.env["ZG_PORT"] ?? 9876);

// 仅 loopback 监听。管理面与转发面都不对外暴露,
// 且绝不把 X-Forwarded-For 当作来源证据(Phase 3 的 loopbackOnly 中间件)。
const HOSTNAME = "127.0.0.1";

serve({ fetch: createApp().fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  console.log(`zen-gateway 已启动 → http://${HOSTNAME}:${info.port}`);
});
