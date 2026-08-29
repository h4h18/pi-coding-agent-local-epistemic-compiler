import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(repo, "packages/contracts/src/index.ts"),
      "@pi-hec/cas": path.join(repo, "packages/cas/src/index.ts"),
      "@pi-hec/security": path.join(repo, "packages/security/src/index.ts"),
      "@pi-hec/instructions": path.join(repo, "packages/instructions/src/index.ts"),
      "@pi-hec/evidence": path.join(repo, "packages/evidence/src/index.ts"),
      "@pi-hec/repository": path.join(repo, "packages/repository/src/index.ts"),
      "@pi-hec/domain": path.join(repo, "packages/domain/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
  },
});
