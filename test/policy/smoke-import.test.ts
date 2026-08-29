import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const contractsUrl = pathToFileURL(
  path.join(repoRoot, "packages", "contracts", "dist", "index.js"),
).href;

void test("contracts smoke-imports its package name constant", async () => {
  const mod = (await import(contractsUrl)) as { packageName: string };
  assert.equal(mod.packageName, "@pi-hec/contracts");
});
