import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const lockPath = path.join(repoRoot, "config", "versions.lock.json");

const requiredPackages = [
  "node",
  "pnpm",
  "typescript",
  "typebox",
  "fastify",
  "@fastify/type-provider-typebox",
  "better-sqlite3",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core",
  "vitest",
  "fast-check",
  "eslint",
  "typescript-eslint",
  "prettier",
  "pino",
  "sqlite-vec",
  "@types/node",
  "rustc",
  "cargo-nextest",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  assert.equal(typeof value, "string", `${label}.${key}`);
  if (typeof value !== "string") {
    throw new TypeError(`${label}.${key} must be a string`);
  }
  return value;
}

function assertLockEntry(name: string, value: unknown): void {
  assert.ok(isRecord(value), `${name} must be an object`);
  assert.notEqual(requireString(value, "version", name), "");
  assert.match(
    requireString(value, "resolvedAt", name),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    `${name}.resolvedAt must be ISO-8601 UTC`,
  );
  assert.match(requireString(value, "sourceUrl", name), /^https?:\/\//, `${name}.sourceUrl`);
}

void test("versions.lock.json has the qualified shape and Node 24 LTS pin", async () => {
  const raw: unknown = JSON.parse(await readFile(lockPath, "utf8"));
  assert.ok(isRecord(raw), "lockfile must be an object");
  assert.ok(isRecord(raw.packages), "packages must be an object");
  assert.ok(isRecord(raw.discoveredRejected), "discoveredRejected must be an object");
  for (const name of requiredPackages) {
    assertLockEntry(name, raw.packages[name]);
  }
  const node = raw.packages.node;
  assert.ok(isRecord(node));
  assert.equal(node.version, "24.20.0");
  const typescript = raw.discoveredRejected.typescript;
  assertLockEntry("discoveredRejected.typescript", typescript);
  assert.ok(isRecord(typescript));
  assert.equal(typescript.version, "7.0.2");
  assert.equal(typeof typescript.reason, "string");
});
