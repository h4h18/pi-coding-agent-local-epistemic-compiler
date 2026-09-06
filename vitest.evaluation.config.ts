import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(repoRoot, "packages", "contracts", "src", "index.ts"),
      "@pi-hec/usage": path.join(repoRoot, "packages", "usage", "src", "projections.ts"),
      "@pi-hec/domain": path.join(repoRoot, "packages", "domain", "src", "index.ts"),
      "@pi-hec/evidence": path.join(repoRoot, "packages", "evidence", "src", "index.ts"),
      "@pi-hec/cas": path.join(repoRoot, "packages", "cas", "src", "index.ts"),
      "@pi-hec/security": path.join(repoRoot, "packages", "security", "src", "index.ts"),
      "@pi-hec/context-compiler": path.join(
        repoRoot,
        "packages",
        "context-compiler",
        "src",
        "index.ts",
      ),
      "@pi-hec/cloud-gateway": path.join(repoRoot, "packages", "cloud-gateway", "src", "index.ts"),
      "@pi-hec/models": path.join(repoRoot, "packages", "models", "src", "index.ts"),
      "@pi-hec/repository": path.join(repoRoot, "packages", "repository", "src", "index.ts"),
      "@earendil-works/pi-coding-agent": path.join(
        repoRoot,
        "apps",
        "pi-extension",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
      ),
    },
  },
  test: {
    name: "evaluation",
    include: ["test/evaluation/**/*.test.ts"],
    passWithNoTests: false,
  },
});
