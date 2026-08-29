import { INDEX_LIMITS, LimitError } from "./limits.js";

export type UntrustedIndexKind = "scip" | "lsp";

export type UntrustedSymbol = {
  path: string;
  symbol: string;
  producer: string;
};

export type UntrustedIndexResult = {
  kind: UntrustedIndexKind;
  producer: string;
  symbols: UntrustedSymbol[];
  rejected: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containedPath(
  path: string,
  allowed: ReadonlySet<string>,
  directories: ReadonlySet<string>,
): boolean {
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..")) {
    return false;
  }
  if (allowed.has(path)) {
    return true;
  }
  for (const entry of allowed) {
    if (!directories.has(entry) && path.startsWith(`${entry}/`)) {
      return false;
    }
  }
  for (const directory of directories) {
    if (path.startsWith(`${directory}/`)) {
      return true;
    }
  }
  return false;
}

export function validateUntrustedIndex(input: {
  kind: UntrustedIndexKind;
  bytes: Uint8Array;
  snapshotPaths: readonly string[];
  directoryPaths?: readonly string[];
}): UntrustedIndexResult {
  if (input.bytes.byteLength > INDEX_LIMITS.scipMaxBytes) {
    throw new LimitError(`${input.kind} index exceeds size limit`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${input.kind} index must be a JSON object`);
  }
  const allowed = new Set(input.snapshotPaths);
  const directories = new Set(input.directoryPaths ?? []);
  const rejected: string[] = [];
  const symbols: UntrustedSymbol[] = [];
  const tool =
    isRecord(parsed.metadata) && isRecord(parsed.metadata.toolInfo) && typeof parsed.metadata.toolInfo.name === "string"
      ? parsed.metadata.toolInfo.name
      : input.kind;
  const producer = `${input.kind}:${tool}`;
  const documents = parsed.documents;
  const definitions = parsed.definitions ?? parsed.symbols;
  const rows = Array.isArray(documents) ? documents : Array.isArray(definitions) ? definitions : [];
  for (const row of rows) {
    if (!isRecord(row)) {
      rejected.push("non-object row");
      continue;
    }
    const path =
      typeof row.relative_path === "string"
        ? row.relative_path
        : typeof row.path === "string"
          ? row.path
          : undefined;
    if (path === undefined || !containedPath(path, allowed, directories)) {
      rejected.push(path ?? "<missing-path>");
      continue;
    }
    const symbol =
      typeof row.symbol === "string"
        ? row.symbol
        : typeof row.name === "string"
          ? row.name
          : path;
    symbols.push({ path, symbol, producer });
    const nested = row.symbols;
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (isRecord(item) && typeof item.symbol === "string") {
          symbols.push({ path, symbol: item.symbol, producer });
        }
      }
    }
  }
  return { kind: input.kind, producer, symbols, rejected };
}
