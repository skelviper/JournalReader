import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    strictPort: true,
  },
  resolve: {
    alias: {
      "@journal-reader/ui": resolve(rootDir, "../../packages/ui/src/index.ts"),
      "@journal-reader/types": resolve(rootDir, "../../packages/types/src/index.ts"),
    },
  },
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
  },
});
