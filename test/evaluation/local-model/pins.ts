import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./digest-file.js";

export type PinMap = Record<string, string>;

export type PinMismatch = {
  relative: string;
  expected: string;
  actual: string;
};

export type PinReport = {
  ok: boolean;
  mismatches: PinMismatch[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadPinMap(pinPath: string): Promise<PinMap> {
  const raw: unknown = JSON.parse(await readFile(pinPath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error("pins.json must be an object");
  }
  const pins: PinMap = {};
  for (const [relative, digest] of Object.entries(raw)) {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`invalid pin for ${relative}`);
    }
    pins[relative] = digest;
  }
  return pins;
}

export async function verifyConfigModelPins(root: string): Promise<PinReport> {
  const modelsDir = path.join(root, "config", "models");
  const pinPath = path.join(modelsDir, "pins.json");
  const pins = await loadPinMap(pinPath);
  const mismatches: PinMismatch[] = [];
  for (const [relative, expected] of Object.entries(pins)) {
    const filePath = path.join(root, ...relative.split("/"));
    if (!existsSync(filePath)) {
      mismatches.push({ relative, expected, actual: "missing-file" });
      continue;
    }
    const actual = await sha256File(filePath);
    if (actual !== expected) {
      mismatches.push({ relative, expected, actual });
    }
  }
  const selectedRelative = "config/models/selected.json";
  if (existsSync(path.join(modelsDir, "selected.json")) && pins[selectedRelative] === undefined) {
    mismatches.push({
      relative: selectedRelative,
      expected: "sha256-pin-required",
      actual: "unpinned",
    });
  }
  const names = existsSync(modelsDir)
    ? (await readdir(modelsDir)).filter((name) => name.endsWith(".json") && name !== "pins.json")
    : [];
  for (const name of names) {
    const raw: unknown = JSON.parse(await readFile(path.join(modelsDir, name), "utf8"));
    if (!isRecord(raw)) {
      continue;
    }
    const productionReady = raw.selected === true || raw.qualificationStatus === "selected";
    if (!productionReady) {
      continue;
    }
    const relative = `config/models/${name}`;
    if (pins[relative] === undefined) {
      mismatches.push({
        relative,
        expected: "sha256-pin-required",
        actual: "unpinned",
      });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
