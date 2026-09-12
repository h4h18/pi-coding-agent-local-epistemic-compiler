import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const IMPORT_USAGE = /@pi-hec\/usage/;

const ALLOWED = new Set([
  path.normalize("packages/usage"),
  path.normalize("client/apps/pi-extension/src/ui/usage-view.ts"),
  path.normalize("faex1/apps/control-plane/src/api/artifacts.ts"),
]);

function walk(dir: string, files: string[]): void {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
      continue;
    }
    if (full.endsWith(".ts") || full.endsWith(".js")) {
      files.push(full);
    }
  }
}

function isAllowed(relative: string): boolean {
  const normalized = path.normalize(relative);
  if (normalized.startsWith(path.normalize("packages/usage") + path.sep)) {
    return true;
  }
  return ALLOWED.has(normalized);
}

test("domain reducer and scheduler paths do not import @pi-hec/usage", () => {
  const files: string[] = [];
  walk(path.join(ROOT, "packages/domain"), files);
  walk(path.join(ROOT, "faex1/apps/control-plane/src/orchestration"), files);
  const offenders = files.filter((file) => {
    const relative = path.relative(ROOT, file);
    if (isAllowed(relative)) {
      return false;
    }
    return IMPORT_USAGE.test(readFileSync(file, "utf8"));
  });
  expect(offenders).toEqual([]);
});

test("no usage value is imported by packages/domain", () => {
  const files: string[] = [];
  walk(path.join(ROOT, "packages/domain"), files);
  const hits = files.filter((file) => IMPORT_USAGE.test(readFileSync(file, "utf8")));
  expect(hits).toEqual([]);
});
