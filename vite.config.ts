import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Tailwind 4 通过 Vite 插件接入：没有 tailwind.config.js，也没有 PostCSS 链。
// token 定义在 src/admin/styles/tokens.css 的 @theme 块里。
export default defineConfig({
  root: fileURLToPath(new URL("src/admin", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("dist/admin", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // 管理面仅 loopback：dev server 也不对外监听。
    host: "127.0.0.1",
    // `/health` 是 doctor.mjs 与 service.mjs 健康等待所用的同一个路径，
    // 不加 /api 前缀，dev 下需单独转发。
    proxy: {
      "/health": { target: "http://127.0.0.1:9876", changeOrigin: false },
      "/api": { target: "http://127.0.0.1:9876", changeOrigin: false },
    },
  },
});
