import { expect, test } from "vitest";
import { chunkSource } from "../src/index.js";
import { SNAPSHOT_ID } from "./helpers.js";

test("JSON schema-object chunks use exact byte and line ranges", () => {
  const text = `{
  "name": "known",
  "nested": { "inner": true },
  "version": "1.0.0"
}
`;
  const units = chunkSource({
    path: "package.json",
    text,
    language: "json",
    snapshotId: SNAPSHOT_ID,
    category: "config",
  });
  const nested = units.find((unit) => unit.kind === "schema-object" && unit.symbolId === "nested");
  expect(nested).toBeDefined();
  const slice = Buffer.from(text, "utf8")
    .subarray(nested?.byteStart ?? 0, nested?.byteEnd ?? 0)
    .toString("utf8");
  expect(slice).toBe('"nested": { "inner": true }');
  expect(nested?.lineStart).toBe(3);
  expect(nested?.lineEnd).toBe(3);
  const name = units.find((unit) => unit.kind === "schema-object" && unit.symbolId === "name");
  expect(name).toBeDefined();
  const nameSlice = Buffer.from(text, "utf8")
    .subarray(name?.byteStart ?? 0, name?.byteEnd ?? 0)
    .toString("utf8");
  expect(nameSlice).toBe('"name": "known"');
});

test("Python def inside a class sets parentSymbol and hierarchy", () => {
  const text = `class Widget:
    def tick(self):
        return 1

def top():
    return 2
`;
  const units = chunkSource({
    path: "src/mod.py",
    text,
    language: "python",
    snapshotId: SNAPSHOT_ID,
    category: "source",
  });
  const method = units.find((unit) => unit.kind === "method" && unit.symbolId === "Widget#tick");
  expect(method).toBeDefined();
  expect(method?.parentHierarchy).toEqual(["src/mod.py", "Widget"]);
  const fn = units.find((unit) => unit.kind === "function" && unit.symbolId === "top");
  expect(fn).toBeDefined();
  expect(fn?.parentHierarchy).toEqual(["src/mod.py"]);
});
