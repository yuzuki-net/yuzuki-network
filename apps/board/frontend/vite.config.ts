import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const adminPages = /\/src\/pages\/(admin|accounts|roles|quotas|nodes|routing|audit|settings|admin-announcements)\//;

export default defineConfig(({ mode }) => {
  const workspace = mode === "workspace";
  const root = fileURLToPath(new URL(".", import.meta.url));
  const output = process.env.YUZUKI_FRONTEND_OUT || resolve(root, "dist");
  return {
    root,
    base: workspace ? "/workspace/" : "/",
    publicDir: false,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(output, workspace ? "private" : "site"),
      emptyOutDir: true,
      rollupOptions: {
        input: (workspace ? ["workspace", "admin"] : ["index", "login", "register"])
          .map((page) => resolve(root, page + ".html")),
        output: {
          chunkFileNames: (chunk) => chunk.facadeModuleId && adminPages.test(chunk.facadeModuleId)
            ? "assets/admin-[name]-[hash].js" : "assets/[name]-[hash].js",
          manualChunks(id) {
            const locale = id.match(/\/i18n\/locales\/(zh-CN|ja|ru|fa)\//)?.[1];
            if (workspace && locale) return `locale-${locale}`;
          },
        },
      },
    },
    server: {
      proxy: { "/auth": "http://127.0.0.1:3000", "/api": "http://127.0.0.1:3000", "/workspace": "http://127.0.0.1:3000", "/admin": "http://127.0.0.1:3000" },
    },
  };
});
