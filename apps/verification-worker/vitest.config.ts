import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(repo, "packages/contracts/src/index.ts"),
      "@pi-hec/domain": path.join(repo, "packages/domain/src/index.ts"),
      "@pi-hec/repository": path.join(repo, "packages/repository/src/index.ts"),
      "@pi-hec/verification": path.join(repo, "packages/verification/src/index.ts"),
      "@pi-hec/sandbox": path.join(repo, "packages/sandbox/src/index.ts"),
      "@pi-hec/security": path.join(repo, "packages/security/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
