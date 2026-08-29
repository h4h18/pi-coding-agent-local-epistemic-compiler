import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import {
  LocalModelProfileSchema,
  RoleIsolationInvariantsSchema,
  RuntimeSlotSchema,
  SelectedSetSchema,
} from "./schema.js";
import { repoRoot } from "./paths.js";
import {
  type LocalModelProfile,
  type RoleIsolationInvariants,
  type RuntimeSlot,
  type SelectedSet,
} from "./types.js";

const localProfileValidator = Compile(LocalModelProfileSchema);
const runtimeSlotValidator = Compile(RuntimeSlotSchema);
const selectedSetValidator = Compile(SelectedSetSchema);
const roleIsolationValidator = Compile(RoleIsolationInvariantsSchema);

export { repoRoot };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type LoadedModelConfig = {
  localProfiles: LocalModelProfile[];
  runtimeSlots: RuntimeSlot[];
  selectedIds: readonly string[];
  roleIsolation: RoleIsolationInvariants;
};

export async function loadModelConfigDirectory(modelsDir: string): Promise<LoadedModelConfig> {
  const names = (await readdir(modelsDir)).filter((name) => name.endsWith(".json")).sort();
  const localProfiles: LocalModelProfile[] = [];
  const runtimeSlots: RuntimeSlot[] = [];
  let selected: SelectedSet | undefined;
  let roleIsolation: RoleIsolationInvariants | undefined;
  for (const name of names) {
    if (name === "pins.json") {
      continue;
    }
    const raw: unknown = JSON.parse(await readFile(path.join(modelsDir, name), "utf8"));
    if (!isRecord(raw)) {
      throw new Error(`${name} is not a JSON object`);
    }
    if (raw.kind === "local-model-profile") {
      if (!localProfileValidator.Check(raw)) {
        throw new Error(`${name} failed LocalModelProfileSchema`);
      }
      localProfiles.push(raw);
      continue;
    }
    if (raw.kind === "runtime-slot") {
      if (!runtimeSlotValidator.Check(raw)) {
        throw new Error(`${name} failed RuntimeSlotSchema`);
      }
      runtimeSlots.push(raw);
      continue;
    }
    if (raw.kind === "selected-set") {
      if (!selectedSetValidator.Check(raw)) {
        throw new Error(`${name} failed SelectedSetSchema`);
      }
      selected = raw;
      continue;
    }
    if (raw.kind === "role-isolation-invariants") {
      if (!roleIsolationValidator.Check(raw)) {
        throw new Error(`${name} failed RoleIsolationInvariantsSchema`);
      }
      roleIsolation = raw;
    }
  }
  if (selected === undefined) {
    throw new Error("config/models/selected.json is missing");
  }
  if (roleIsolation === undefined) {
    throw new Error("config/models/role-isolation.json is missing");
  }
  return {
    localProfiles,
    runtimeSlots,
    selectedIds: selected.selectedIds,
    roleIsolation,
  };
}
