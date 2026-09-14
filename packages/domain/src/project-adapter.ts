import { Compile } from "typebox/compile";
import { ProjectAdapterSchema, type ProjectAdapter, type SnapshotEntry } from "@pi-hec/contracts";

const ADAPTER = Compile(ProjectAdapterSchema);

const IMMUTABLE_DEFAULTS = {
  networkDefault: "deny",
  nestedDelegation: false,
  applyToUserTree: "explicit",
} as const;

export const PROJECT_ADAPTER_SNAPSHOT_PATHS = [
  ".pi/hec-adapter.yaml",
  ".pi/hec-adapter.yml",
  ".pi/hec-adapter.json",
] as const;

export const DEFAULT_PROJECT_ADAPTER: ProjectAdapter = {
  schemaVersion: 1,
  project: { id: "auto", adapter: "auto" },
  spec: { roots: ["specs"], behaviorChangeRequiresUpdate: true },
  verification: { baseline: [], targeted: [], final: [], packs: {} },
  protectedPaths: [".env*", ".git/**"],
  network: { default: "deny", externalResearch: "deny" },
};

export type ProjectLock = {
  adapter: ProjectAdapter;
  tightened: boolean;
};

export function isProjectAdapterSnapshotPath(path: string): boolean {
  return (PROJECT_ADAPTER_SNAPSHOT_PATHS as readonly string[]).includes(path);
}

export function findProjectAdapterSnapshotEntry(
  entries: readonly SnapshotEntry[],
): Extract<SnapshotEntry, { entryType: "file" }> | undefined {
  for (const path of PROJECT_ADAPTER_SNAPSHOT_PATHS) {
    const match = entries.find(
      (entry): entry is Extract<SnapshotEntry, { entryType: "file" }> =>
        entry.entryType === "file" && entry.path === path,
    );
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function networkDefaultOf(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, "network")) {
    return undefined;
  }
  const network = (value as { network: unknown }).network;
  if (network === null || typeof network !== "object" || !Object.hasOwn(network, "default")) {
    return undefined;
  }
  return (network as { default: unknown }).default;
}

export function validateProjectAdapter(value: unknown): ProjectAdapter {
  const networkDefault = networkDefaultOf(value);
  if (networkDefault !== undefined && networkDefault !== IMMUTABLE_DEFAULTS.networkDefault) {
    throw new Error("project adapter cannot weaken network default");
  }
  if (!ADAPTER.Check(value)) {
    throw new Error("project adapter failed schema");
  }
  if (value.network.default !== IMMUTABLE_DEFAULTS.networkDefault) {
    throw new Error("project adapter cannot weaken network default");
  }
  return value;
}

export function lockProjectAdapter(candidate: unknown | undefined): ProjectLock {
  if (candidate === undefined) {
    return { adapter: DEFAULT_PROJECT_ADAPTER, tightened: false };
  }
  const overlay = validateProjectAdapter(candidate);
  return {
    adapter: mergeTightening(DEFAULT_PROJECT_ADAPTER, overlay),
    tightened: true,
  };
}

export function lockProjectAdapterFromDocument(text: string): ProjectLock {
  return lockProjectAdapter(parseProjectAdapterDocument(text));
}

export function parseProjectAdapterDocument(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/u, "").trim();
  if (trimmed.length === 0) {
    throw new Error("project adapter document is empty");
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed) as unknown;
  }
  return parseRestrictedYaml(trimmed);
}

export function mergeTightening(base: ProjectAdapter, overlay: ProjectAdapter): ProjectAdapter {
  return {
    schemaVersion: 1,
    project: overlay.project,
    spec: {
      roots: [...new Set([...base.spec.roots, ...overlay.spec.roots])],
      behaviorChangeRequiresUpdate:
        base.spec.behaviorChangeRequiresUpdate || overlay.spec.behaviorChangeRequiresUpdate,
    },
    verification: {
      baseline: [...base.verification.baseline, ...overlay.verification.baseline],
      targeted: [...base.verification.targeted, ...overlay.verification.targeted],
      final: [...base.verification.final, ...overlay.verification.final],
      packs: {
        ...(base.verification.packs ?? {}),
        ...(overlay.verification.packs ?? {}),
      },
    },
    protectedPaths: [...new Set([...base.protectedPaths, ...overlay.protectedPaths])],
    network: {
      default: "deny",
      externalResearch:
        base.network.externalResearch === "deny" || overlay.network.externalResearch === "deny"
          ? "deny"
          : "allow",
    },
  };
}

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

function parseRestrictedYaml(text: string): unknown {
  if (/!!|&[A-Za-z0-9_]|^\s*\*/mu.test(text) || text.includes("<<:")) {
    throw new Error("project adapter yaml tags, aliases, or merge keys are not allowed");
  }
  const lines = text.split(/\r?\n/u);
  const parsed = parseYamlValue(lines, 0, 0);
  const leftover = skipEmpty(lines, parsed.next);
  if (leftover < lines.length) {
    throw new Error("unexpected trailing yaml");
  }
  return parsed.value;
}

function skipEmpty(lines: readonly string[], index: number): number {
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function leadingSpaces(line: string): number {
  const match = /^( *)/u.exec(line.replaceAll("\t", "  "));
  return match?.[1]?.length ?? 0;
}

function parseYamlValue(
  lines: readonly string[],
  index: number,
  indent: number,
): { value: YamlValue; next: number } {
  const start = skipEmpty(lines, index);
  const line = lines[start];
  if (line === undefined) {
    return { value: {}, next: start };
  }
  const trimmed = line.trim();
  if (trimmed.startsWith("- ")) {
    return parseYamlList(lines, start, indent);
  }
  return parseYamlMapping(lines, start, indent);
}

function parseYamlMapping(
  lines: readonly string[],
  index: number,
  indent: number,
): { value: { [key: string]: YamlValue }; next: number } {
  const result: { [key: string]: YamlValue } = {};
  let i = index;
  while (i < lines.length) {
    i = skipEmpty(lines, i);
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const spaces = leadingSpaces(line.replaceAll("\t", "  "));
    if (spaces < indent) {
      break;
    }
    if (spaces > indent) {
      throw new Error("invalid yaml indent");
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      break;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      throw new Error(`invalid yaml line: ${trimmed}`);
    }
    const key = parseYamlScalar(trimmed.slice(0, colon).trim());
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("invalid yaml key");
    }
    const rest = trimmed.slice(colon + 1).trim();
    i += 1;
    if (rest.length === 0 || rest === "|" || rest === ">") {
      const nested = parseYamlValue(lines, i, indent + 2);
      result[key] = nested.value;
      i = nested.next;
      continue;
    }
    result[key] = parseYamlScalar(rest);
  }
  return { value: result, next: i };
}

function parseYamlList(
  lines: readonly string[],
  index: number,
  indent: number,
): { value: YamlValue[]; next: number } {
  const result: YamlValue[] = [];
  let i = index;
  while (i < lines.length) {
    i = skipEmpty(lines, i);
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    const normalized = line.replaceAll("\t", "  ");
    const spaces = leadingSpaces(normalized);
    if (spaces < indent) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      break;
    }
    const rest = trimmed.slice(2).trim();
    i += 1;
    if (rest.length === 0) {
      const nested = parseYamlValue(lines, i, spaces + 2);
      result.push(nested.value);
      i = nested.next;
      continue;
    }
    if (rest.includes(":")) {
      const itemIndent = spaces + 2;
      const spliced = [`${" ".repeat(itemIndent)}${rest}`, ...lines.slice(i)];
      const nested = parseYamlMapping(spliced, 0, itemIndent);
      result.push(nested.value);
      i += Math.max(nested.next - 1, 0);
      continue;
    }
    result.push(parseYamlScalar(rest));
  }
  return { value: result, next: i };
}

function parseYamlScalar(raw: string): YamlValue {
  if (raw === "~" || raw === "null") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "[]") {
    return [];
  }
  if (raw === "{}") {
    return {};
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  if (/^-?(0|[1-9][0-9]*)$/u.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  return raw;
}
