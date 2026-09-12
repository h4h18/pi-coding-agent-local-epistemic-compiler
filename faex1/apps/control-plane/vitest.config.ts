import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(repo, "packages/contracts/src/index.ts"),
      "@pi-hec/domain": path.join(repo, "packages/domain/src/index.ts"),
      "@pi-hec/state-store": path.join(repo, "packages/state-store/src/index.ts"),
      "@pi-hec/cas": path.join(repo, "packages/cas/src/index.ts"),
      "@pi-hec/models": path.join(repo, "packages/models/src/index.ts"),
      "@pi-hec/security": path.join(repo, "packages/security/src/index.ts"),
      "@pi-hec/client": path.join(repo, "packages/client/src/index.ts"),
      "@pi-hec/cloud-gateway": path.join(repo, "packages/cloud-gateway/src/index.ts"),
      "@pi-hec/preflight": path.join(repo, "packages/preflight/src/index.ts"),
      "@pi-hec/context-compiler": path.join(repo, "packages/context-compiler/src/index.ts"),
      "@pi-hec/verification": path.join(repo, "packages/verification/src/index.ts"),
      "@pi-hec/evidence": path.join(repo, "packages/evidence/src/index.ts"),
      "@pi-hec/instructions": path.join(repo, "packages/instructions/src/index.ts"),
      "@pi-hec/repository": path.join(repo, "packages/repository/src/index.ts"),
      "@pi-hec/sandbox": path.join(repo, "packages/sandbox/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "../../test/contract/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
