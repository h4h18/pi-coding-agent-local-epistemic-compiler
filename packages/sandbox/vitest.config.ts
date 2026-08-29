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
    },
  },
  test: {
    include: ["test/**/*.test.ts", "../../test/security/sandbox/**/*.test.ts"],
    exclude: ["../../test/security/sandbox/secrets.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
