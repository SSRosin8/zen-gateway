import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        // 服务端 / 核心逻辑 / 设计 token 断言：纯 Node,无 DOM。
        test: {
          name: "node",
          root,
          environment: "node",
          include: ["tests/{unit,integration,design}/**/*.test.ts"],
        },
      },
      {
        // 管理后台组件测试。
        test: {
          name: "admin",
          root,
          environment: "jsdom",
          include: ["tests/admin/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/admin/setup.ts"],
        },
      },
    ],
  },
});
