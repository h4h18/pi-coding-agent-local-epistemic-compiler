import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  INDEX_LIMITS,
  LimitError,
  UnpinnedGrammarError,
  assertWithinBudget,
  enrichWithTreeSitter,
  initTreeSitterRuntime,
  validateUntrustedIndex,
} from "../src/index.js";
import { SNAPSHOT_ID } from "./helpers.js";

test("web-tree-sitter runtime WASM loads from the pinned package", async () => {
  await initTreeSitterRuntime();
});

test("untrusted SCIP indexes validate path containment and keep producer provenance", () => {
  const payload = {
    metadata: { toolInfo: { name: "scip-typescript" } },
    documents: [
      { relative_path: "src/math.ts", symbols: [{ symbol: "add" }] },
      { relative_path: "../escape.ts", symbols: [{ symbol: "evil" }] },
      { relative_path: "src/math.ts/not-in-snapshot", symbols: [{ symbol: "spoof" }] },
    ],
  };
  const result = validateUntrustedIndex({
    kind: "scip",
    bytes: Buffer.from(JSON.stringify(payload), "utf8"),
    snapshotPaths: ["src", "src/math.ts"],
    directoryPaths: ["src"],
  });
  expect(result.producer).toBe("scip:scip-typescript");
  expect(result.symbols.some((item) => item.symbol === "add")).toBe(true);
  expect(result.rejected.some((item) => item.includes("escape"))).toBe(true);
  expect(result.rejected).toContain("src/math.ts/not-in-snapshot");
  expect(result.symbols.some((item) => item.path === "src/math.ts/not-in-snapshot")).toBe(false);
});

test("unpinned grammar WASM paths are rejected before any read", async () => {
  await expect(
    enrichWithTreeSitter({
      path: "src/math.ts",
      text: "export function add() { return 1; }\n",
      language: "typescript",
      snapshotId: SNAPSHOT_ID,
      category: "source",
      grammarWasm: { typescript: path.join(os.tmpdir(), "pi-hec-unpinned-evil.wasm") },
    }),
  ).rejects.toBeInstanceOf(UnpinnedGrammarError);
});

test("pinned TypeScript grammar emits tree-sitter function units", async () => {
  const result = await enrichWithTreeSitter({
    path: "src/math.ts",
    text: "export function add(a: number, b: number) { return a + b; }\n",
    language: "typescript",
    snapshotId: SNAPSHOT_ID,
    category: "source",
  });
  expect(result.usedTreeSitter).toBe(true);
  expect(result.producer).toBe("web-tree-sitter/0.26.13");
  expect(result.units.some((unit) => unit.kind === "function" && unit.symbolId === "add")).toBe(
    true,
  );
});

test("assertWithinBudget fails closed when parse time is exceeded", () => {
  expect(() => {
    assertWithinBudget(Date.now() - INDEX_LIMITS.parseBudgetMs - 5, "parse");
  }).toThrow(LimitError);
});
