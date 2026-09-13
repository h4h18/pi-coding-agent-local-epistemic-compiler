import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

function workspaceJsToTs(): Plugin {
  return {
    name: "hec-workspace-js-to-ts",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(".js") || importer === undefined) {
        return undefined;
      }
      const candidate = path
        .normalize(path.resolve(path.dirname(importer), source))
        .replace(/\.js$/u, ".ts");
      const root = path.normalize(here);
      const inside =
        candidate === root ||
        candidate.startsWith(root + path.sep) ||
        candidate.toLowerCase().startsWith(root.toLowerCase() + path.sep);
      if (inside && existsSync(candidate)) {
        return candidate;
      }
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [workspaceJsToTs()],
  resolve: {
    alias: {
      "@pi-hec/contracts": path.join(here, "packages/contracts/src/index.ts"),
      "@pi-hec/domain": path.join(here, "packages/domain/src/index.ts"),
      "@pi-hec/repository": path.join(here, "packages/repository/src/index.ts"),
      "@pi-hec/instructions": path.join(here, "packages/instructions/src/index.ts"),
      "@pi-hec/evidence": path.join(here, "packages/evidence/src/index.ts"),
      "@pi-hec/models": path.join(here, "packages/models/src/index.ts"),
      "@pi-hec/preflight": path.join(here, "packages/preflight/src/index.ts"),
      "@pi-hec/security": path.join(here, "packages/security/src/index.ts"),
      "@pi-hec/context-compiler": path.join(here, "packages/context-compiler/src/index.ts"),
      "@pi-hec/sandbox": path.join(here, "packages/sandbox/src/index.ts"),
      "@pi-hec/cas": path.join(here, "packages/cas/src/index.ts"),
      "@pi-hec/state-store": path.join(here, "packages/state-store/src/index.ts"),
      "@pi-hec/usage": path.join(here, "packages/usage/src/projections.ts"),
      "@pi-hec/cloud-gateway": path.join(here, "packages/cloud-gateway/src/index.ts"),
      "@pi-hec/verification": path.join(here, "packages/verification/src/index.ts"),
      "@earendil-works/pi-coding-agent": path.join(
        here,
        "client/apps/pi-extension/node_modules/@earendil-works/pi-coding-agent",
      ),
    },
  },
  test: {
    name: "e2e",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    passWithNoTests: false,
    deps: {
      moduleDirectories: [
        "node_modules",
        path.join(here, "packages/models/node_modules"),
        path.join(here, "client/apps/pi-extension/node_modules"),
      ],
    },
  },
});
