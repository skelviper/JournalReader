import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@journal-reader/types": resolve(rootDir, "packages/types/src/index.ts"),
      "@journal-reader/parser": resolve(rootDir, "packages/parser/src/index.ts"),
      "@journal-reader/storage": resolve(rootDir, "packages/storage/src/index.ts"),
      "@journal-reader/pdf-core": resolve(rootDir, "packages/pdf-core/src/index.ts"),
      "@journal-reader/ui": resolve(rootDir, "packages/ui/src/index.ts"),
    },
  },
});
