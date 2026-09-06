import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type PinnedGrammar = {
  language: string;
  relativePath: string;
  sha256: string;
  absolutePath: string;
};

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  javascript: "typescript",
  typescript: "typescript",
};

export class UnpinnedGrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpinnedGrammarError";
  }
}

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let index = 0; index < 16; index += 1) {
    if (existsSync(path.join(dir, "config", "versions.lock.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("repository root with config/versions.lock.json was not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPinnedGrammars(repoRoot: string): ReadonlyMap<string, PinnedGrammar> {
  const lockPath = path.join(repoRoot, "config", "versions.lock.json");
  const raw: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!isRecord(raw) || !isRecord(raw.artifacts)) {
    return new Map();
  }
  const out = new Map<string, PinnedGrammar>();
  for (const [rel, value] of Object.entries(raw.artifacts)) {
    if (
      !isRecord(value) ||
      typeof value.sha256 !== "string" ||
      typeof value.language !== "string"
    ) {
      continue;
    }
    const normalized = rel.replaceAll("\\", "/");
    if (!normalized.startsWith("deploy/tree-sitter/") || normalized.includes("..")) {
      continue;
    }
    out.set(value.language, {
      language: value.language,
      relativePath: normalized,
      sha256: value.sha256.toLowerCase(),
      absolutePath: path.resolve(repoRoot, normalized),
    });
  }
  return out;
}

export function pinnedGrammarDigests(): Record<string, string> {
  const root = findRepoRoot(fileURLToPath(new URL(".", import.meta.url)));
  const map = loadPinnedGrammars(root);
  const out: Record<string, string> = {};
  for (const [language, pin] of map) {
    out[language] = pin.sha256;
  }
  return out;
}

function isInsideAllowDir(allowDir: string, candidate: string): boolean {
  const rel = path.relative(allowDir, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function resolvePinnedGrammarBytes(
  language: string,
  requestedPath: string | undefined,
): Uint8Array | undefined {
  const root = findRepoRoot(fileURLToPath(new URL(".", import.meta.url)));
  const allowDir = path.resolve(root, "deploy", "tree-sitter");
  const pins = loadPinnedGrammars(root);
  const canonical = LANGUAGE_ALIASES[language] ?? language;
  const pin = pins.get(canonical);
  if (requestedPath !== undefined) {
    const requestedAbs = path.resolve(requestedPath);
    if (!isInsideAllowDir(allowDir, requestedAbs)) {
      throw new UnpinnedGrammarError(`unpinned grammar WASM rejected: ${requestedPath}`);
    }
    if (pin === undefined || path.resolve(pin.absolutePath) !== requestedAbs) {
      throw new UnpinnedGrammarError(`unpinned grammar WASM rejected: ${requestedPath}`);
    }
  }
  if (pin === undefined) {
    return undefined;
  }
  if (!isInsideAllowDir(allowDir, pin.absolutePath)) {
    throw new UnpinnedGrammarError(`unpinned grammar WASM rejected: ${pin.relativePath}`);
  }
  if (!existsSync(pin.absolutePath)) {
    return undefined;
  }
  const bytes = readFileSync(pin.absolutePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== pin.sha256) {
    throw new UnpinnedGrammarError(`grammar WASM hash mismatch for ${canonical}`);
  }
  return bytes;
}
