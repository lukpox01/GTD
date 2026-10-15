import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Built into dashboard/dist, which wrangler serves as static assets.
// `npm run dev:dashboard` proxies /api to `npm run dev` (wrangler on :8787).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
