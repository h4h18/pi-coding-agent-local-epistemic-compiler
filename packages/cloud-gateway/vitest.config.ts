import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(repo, "packages/contracts/src/index.ts"),
      "@pi-hec/security": path.join(repo, "packages/security/src/index.ts"),
      "@pi-hec/models": path.join(repo, "packages/models/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
