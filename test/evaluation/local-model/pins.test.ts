import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { repoRoot } from "./paths.js";
import { loadPinMap, verifyConfigModelPins } from "./pins.js";
import { sha256File } from "./digest-file.js";

test("selected manifests are listed in pins even when the selected set is empty", async () => {
  const pins = await loadPinMap(path.join(repoRoot(), "config", "models", "pins.json"));
  expect(pins["config/models/selected.json"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  const report = await verifyConfigModelPins(repoRoot());
  expect(report.ok).toBe(true);
  expect(report.mismatches).toEqual([]);
});

test("pin mismatch fails when a selected or production-ready file byte changes", async () => {
  const dir = path.join(tmpdir(), `pi-hec-pins-${String(Date.now())}`);
  await mkdir(path.join(dir, "config", "models"), { recursive: true });
  const selectedPath = path.join(dir, "config", "models", "selected.json");
  await writeFile(selectedPath, '{"kind":"selected-set","schemaVersion":1,"selectedIds":[]}\n');
  const digest = await sha256File(selectedPath);
  await writeFile(
    path.join(dir, "config", "models", "pins.json"),
    `${JSON.stringify({ "config/models/selected.json": digest }, null, 2)}\n`,
  );
  const ok = await verifyConfigModelPins(dir);
  expect(ok.ok).toBe(true);
  await writeFile(
    selectedPath,
    '{"kind":"selected-set","schemaVersion":1,"selectedIds":["forged"]}\n',
  );
  const broken = await verifyConfigModelPins(dir);
  expect(broken.ok).toBe(false);
  expect(broken.mismatches.length).toBeGreaterThan(0);
});

test("committed pins match current config/models bytes for every pinned path", async () => {
  const root = repoRoot();
  const pins = await loadPinMap(path.join(root, "config", "models", "pins.json"));
  expect(Object.keys(pins).length).toBeGreaterThan(0);
  for (const [relative, digest] of Object.entries(pins)) {
    const actual = await sha256File(path.join(root, relative));
    expect(actual).toBe(digest);
    const bytes = await readFile(path.join(root, relative));
    expect(bytes.byteLength).toBeGreaterThan(0);
  }
});
