import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolvePort } from "./src/store/port.ts";
import { DEFAULT_ADMIN_PORT } from "./src/store/port.ts";

// Tailwind 4 通过 Vite 插件接入：没有 tailwind.config.js，也没有 PostCSS 链。
// token 定义在 src/admin/styles/tokens.css 的 @theme 块里。

/*
 * dev 代理的目标端口**必须与服务端实际监听的一致**，所以从 `store/port.ts`
 * 解析，不写字面量。
 *
 * 这里先前硬编码默认端口，而服务端端口是可配的（`gateway.port`）。
 * 症状比"端口写错"更隐蔽：dev server 照常起、页面照常打开，只是
 * `/health` 与 `/api` 被转发到**另一个进程**，于是 admin 会拿到别的服务的响应，
 * 一个"看起来在工作但数据来自错误后端"的故障，且不报任何错。
 *
 * 用 `fileURLToPath(new URL("."))` 而不是 cwd：vite 可能从别处被调起。
 */
/** 与 service.mjs 相同：ZG_DATA_DIR 存在时由 paths.ts 读取它指定的 config。 */
export function resolveViteServerPort(): number {
  return resolvePort(
    process.env.ZG_DATA_DIR ? undefined : fileURLToPath(new URL(".", import.meta.url)),
  );
}

/** 导出构造函数，让测试能在临时 ZG_DATA_DIR 下验证真正的代理 target。 */
export function createViteConfig() {
  const serverPort = resolveViteServerPort();
  const proxy = {
    "/health": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
    "/api": { target: `http://127.0.0.1:${serverPort}`, changeOrigin: false },
  };
  return defineConfig({
    root: fileURLToPath(new URL("src/admin", import.meta.url)),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: fileURLToPath(new URL("dist/admin", import.meta.url)),
      emptyOutDir: true,
      sourcemap: true,
    },
    server: {
      port: DEFAULT_ADMIN_PORT,
      strictPort: true,
      /*
       * 开发用（热更新）。只在本机监听，**不能**开到局域网：它按需伺服项目目录下的任意源文件
       * （`/@fs/`），`data/config.json` 里的 API key 也在其中。日常使用与局域网访问走
       * `npm start` 起的后台页面（server/adminSite.ts），它只伺服构建产物。
       * 与 `npm start` 同时运行时两者抢 5173：先起的占住，网关会报后台端口被占。
       */
      host: "127.0.0.1",
      // `/health` 是 doctor.mjs 与 service.mjs 健康等待所用的同一个路径，
      // 不加 /api 前缀，dev 下需单独转发。
      proxy,
    },
  });
}

export default createViteConfig();
