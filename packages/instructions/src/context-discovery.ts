import { Compile } from "typebox/compile";
import {
  InstructionDescriptorSchema,
  objectDigestFromBytes,
  sha256Hex,
  taggedHash,
  type Digest,
  type InstructionManifest,
  type ObjectDigest,
  type SnapshotEntry,
  type SnapshotId,
  type SourceRef,
} from "@pi-hec/contracts";

export const CONTEXT_FILE_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

export type ContextFileName = (typeof CONTEXT_FILE_CANDIDATES)[number];

export const MODEL_CONTEXT_MISSING = "MODEL_CONTEXT_MISSING";

export type TrustLabel = "platform" | "user" | "trusted-project" | "untrusted-data";

export type SnapshotNode =
  | { path: string; kind: "file"; bytes: Uint8Array }
  | { path: string; kind: "directory" }
  | { path: string; kind: "symlink"; target: string }
  | { path: string; kind: "submodule" };

export type YamlValue = string | boolean | number | YamlValue[] | YamlMap;
export type YamlMap = { readonly [key: string]: YamlValue };

export type FrontmatterDocument = {
  fields: YamlMap;
  body: string;
  hasFrontmatter: boolean;
};

export type FrontmatterResult = FrontmatterDocument | { error: string };

export type ExternalInstructionSource = {
  trust: "platform" | "user";
  pathLabel: string;
  bytes: Uint8Array;
  artifactObjectDigest?: ObjectDigest;
};

export type WorktreeShadow = {
  worktreeRoot: string;
  filename: string;
  shadowedPath: string;
};

export type InstructionCollision = {
  paths: readonly string[];
  reason: string;
};

export type DiscoveredContextFile = {
  id: string;
  scope: string;
  filename: string;
  path: string;
  body: string;
  bytes: Uint8Array;
  contentDigest: Digest;
  trust: TrustLabel;
  sourceRef: SourceRef;
  precedence: number;
};

export type ContextDiscoveryInput = {
  snapshotId: SnapshotId;
  nodes: readonly SnapshotNode[];
  projectTrusted: boolean;
  globalSources?: readonly ExternalInstructionSource[];
  changesetTouchedInstructionPaths?: readonly string[];
};

export type ContextDiscoveryResult = {
  files: readonly DiscoveredContextFile[];
  collisions: readonly InstructionCollision[];
  worktreeShadows: readonly WorktreeShadow[];
};

const INSTRUCTION_DESCRIPTOR = Compile(InstructionDescriptorSchema);
const CONTEXT_NAME_SET = new Set<string>(CONTEXT_FILE_CANDIDATES);

export function nodesFromSnapshotEntries(
  entries: readonly SnapshotEntry[],
  fileBytes: ReadonlyMap<string, Uint8Array>,
): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  for (const entry of entries) {
    switch (entry.entryType) {
      case "file": {
        const bytes = fileBytes.get(entry.path);
        if (bytes === undefined) {
          throw new Error(`missing snapshot bytes for ${entry.path}`);
        }
        nodes.push({ path: entry.path, kind: "file", bytes });
        break;
      }
      case "directory":
        nodes.push({ path: entry.path, kind: "directory" });
        break;
      case "symlink":
        nodes.push({ path: entry.path, kind: "symlink", target: entry.symlinkTarget });
        break;
      case "submodule":
        nodes.push({ path: entry.path, kind: "submodule" });
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(`unhandled snapshot entry ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return nodes;
}

export function quoteDigestForBytes(bytes: Uint8Array): Digest {
  return taggedHash("quote", 1, {
    bytesBase64url: Buffer.from(bytes).toString("base64url"),
  });
}

export function repositorySourceRef(input: {
  snapshotId: SnapshotId;
  path: string;
  bytes: Uint8Array;
  sourceKind: "project-instruction" | "repository";
}): SourceRef {
  return {
    origin: "repository",
    sourceKind: input.sourceKind,
    snapshotId: input.snapshotId,
    artifactObjectDigest: objectDigestFromBytes(input.bytes),
    path: input.path,
    range: { kind: "whole" },
    quoteDigest: quoteDigestForBytes(input.bytes),
  };
}

export function artifactSourceRef(input: {
  bytes: Uint8Array;
  artifactObjectDigest?: ObjectDigest | undefined;
  sourceKind: "user-task" | "platform-policy";
}): SourceRef {
  return {
    origin: "artifact",
    sourceKind: input.sourceKind,
    artifactObjectDigest: input.artifactObjectDigest ?? objectDigestFromBytes(input.bytes),
    range: { kind: "whole" },
    quoteDigest: quoteDigestForBytes(input.bytes),
  };
}

export function nfc(value: string): string {
  return value.normalize("NFC");
}

export function posixDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

export function posixBasename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function posixJoin(left: string, right: string): string {
  if (left === "." || left === "") {
    return right;
  }
  if (right === "." || right === "") {
    return left;
  }
  return `${left}/${right}`;
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  if (root === "." || root === "") {
    return !candidate.split("/").includes("..");
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function ancestorScopes(path: string): string[] {
  if (path === "." || path === "") {
    return ["."];
  }
  const segments = path.split("/");
  const scopes = ["."];
  for (let index = 0; index < segments.length; index += 1) {
    scopes.push(segments.slice(0, index + 1).join("/"));
  }
  return scopes;
}

export function pathHasBlockedAncestor(
  path: string,
  blocked: ReadonlySet<string>,
): boolean {
  for (const scope of ancestorScopes(path)) {
    if (scope !== "." && blocked.has(scope)) {
      return true;
    }
  }
  return blocked.has(path);
}

export function isSafeSnapshotPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/")) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function asUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

export function parseYamlFrontmatter(text: string): FrontmatterResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalized = stripped.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---" && !normalized.startsWith("---\r")) {
    return { fields: {}, body: text, hasFrontmatter: false };
  }
  const rest = normalized.startsWith("---\n") ? normalized.slice(4) : normalized.slice(3);
  const close = rest.search(/\n---(?:\n|$)/);
  if (close === -1) {
    return { error: "unterminated frontmatter" };
  }
  const yamlBlock = rest.slice(0, close);
  const body = rest.slice(close + 5);
  if (/!!|&[A-Za-z0-9_]|^\s*\*/m.test(yamlBlock) || yamlBlock.includes("<<:")) {
    return { error: "yaml tags, aliases, or merge keys are not allowed" };
  }
  try {
    const fields = parseYamlMap(yamlBlock);
    return { fields, body, hasFrontmatter: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid frontmatter" };
  }
}

export function yamlStringList(value: YamlValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function yamlMap(value: YamlValue | undefined): YamlMap {
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

export function discoverContextFiles(input: ContextDiscoveryInput): ContextDiscoveryResult {
  const blocked = blockedPrefixes(input.nodes);
  const exclude = new Set(
    (input.changesetTouchedInstructionPaths ?? []).map((path) => nfc(path)),
  );
  const filesByDir = new Map<string, Map<string, { path: string; bytes: Uint8Array }>>();
  const identityGroups = new Map<string, string[]>();
  const collisions: InstructionCollision[] = [];

  for (const node of input.nodes) {
    if (node.kind !== "file") {
      continue;
    }
    if (!isSafeSnapshotPath(node.path) || pathHasBlockedAncestor(nfc(node.path), blocked)) {
      continue;
    }
    const identity = nfc(node.path);
    const filename = posixBasename(identity);
    if (!CONTEXT_NAME_SET.has(filename)) {
      continue;
    }
    const group = identityGroups.get(identity) ?? [];
    group.push(node.path);
    identityGroups.set(identity, group);
  }

  const collided = new Set<string>();
  for (const [identity, paths] of identityGroups) {
    const unique = [...new Set(paths)];
    if (unique.length > 1) {
      collided.add(identity);
      collisions.push({
        paths: unique.sort(),
        reason: `Unicode alias collision for instruction path ${identity}`,
      });
    }
  }

  for (const [identity, paths] of identityGroups) {
    if (collided.has(identity) || exclude.has(identity)) {
      continue;
    }
    const raw = paths[0];
    if (raw === undefined || exclude.has(raw)) {
      continue;
    }
    const node = input.nodes.find((item) => item.kind === "file" && item.path === raw);
    if (node === undefined || node.kind !== "file") {
      continue;
    }
    const filename = posixBasename(identity);
    const dir = posixDirname(identity);
    const dirFiles = filesByDir.get(dir) ?? new Map<string, { path: string; bytes: Uint8Array }>();
    if (!dirFiles.has(filename)) {
      dirFiles.set(filename, { path: identity, bytes: node.bytes });
    }
    filesByDir.set(dir, dirFiles);
  }

  const selected: DiscoveredContextFile[] = [];
  let precedence = 0;
  for (const source of input.globalSources ?? []) {
    const filename = posixBasename(source.pathLabel);
    if (!CONTEXT_NAME_SET.has(filename)) {
      continue;
    }
    const file = commitDiscovered(
      {
        id: instructionId(`global:${source.trust}:${filename}`),
        scope: ".",
        filename,
        path: `global/${source.trust}/${filename}`,
        bytes: source.bytes,
        trust: source.trust,
        sourceRef: artifactSourceRef({
          bytes: source.bytes,
          artifactObjectDigest: source.artifactObjectDigest,
          sourceKind: source.trust === "platform" ? "platform-policy" : "user-task",
        }),
        precedence,
        snapshotId: input.snapshotId,
        repository: false,
      },
      collisions,
    );
    if (file !== undefined) {
      selected.push(file);
      precedence += 1;
    }
  }

  const directories = [...filesByDir.keys()].sort(compareScope);
  for (const directory of directories) {
    const dirFiles = filesByDir.get(directory);
    if (dirFiles === undefined) {
      continue;
    }
    const hit = selectCandidate(dirFiles);
    if (hit === undefined) {
      continue;
    }
    const trust: TrustLabel = input.projectTrusted ? "trusted-project" : "untrusted-data";
    const file = commitDiscovered(
      {
        id: instructionId(hit.path),
        scope: directory,
        filename: posixBasename(hit.path),
        path: hit.path,
        bytes: hit.bytes,
        trust,
        sourceRef: repositorySourceRef({
          snapshotId: input.snapshotId,
          path: hit.path,
          bytes: hit.bytes,
          sourceKind: "project-instruction",
        }),
        precedence,
        snapshotId: input.snapshotId,
        repository: true,
      },
      collisions,
    );
    if (file !== undefined) {
      selected.push(file);
      precedence += 1;
    }
  }

  return {
    files: selected,
    collisions,
    worktreeShadows: findWorktreeShadows(input.nodes, selected),
  };
}

export function instructionDescriptor(file: DiscoveredContextFile): InstructionManifest["instructions"][number] {
  const descriptor = {
    id: file.id,
    scope: file.scope,
    precedence: file.precedence,
    trust: file.trust,
    sourceRef: file.sourceRef,
    contentDigest: file.contentDigest,
  };
  if (!INSTRUCTION_DESCRIPTOR.Check(descriptor)) {
    throw new Error(`instruction descriptor schema invalid for ${file.path}`);
  }
  return descriptor;
}

function commitDiscovered(
  input: {
    id: string;
    scope: string;
    filename: string;
    path: string;
    bytes: Uint8Array;
    trust: TrustLabel;
    sourceRef: SourceRef;
    precedence: number;
    snapshotId: SnapshotId;
    repository: boolean;
  },
  collisions: InstructionCollision[],
): DiscoveredContextFile | undefined {
  const file = toDiscovered(input);
  if (file !== undefined) {
    return file;
  }
  collisions.push({
    paths: [input.path],
    reason: `instruction descriptor schema invalid for ${input.path}; directory skipped without falling through to a lower-precedence context file`,
  });
  return undefined;
}

function toDiscovered(input: {
  id: string;
  scope: string;
  filename: string;
  path: string;
  bytes: Uint8Array;
  trust: TrustLabel;
  sourceRef: SourceRef;
  precedence: number;
  snapshotId: SnapshotId;
  repository: boolean;
}): DiscoveredContextFile | undefined {
  const body = asUtf8(input.bytes);
  const file: DiscoveredContextFile = {
    id: input.id,
    scope: input.scope,
    filename: input.filename,
    path: input.repository ? input.path : input.id,
    body,
    bytes: input.bytes,
    contentDigest: sha256Hex(input.bytes),
    trust: input.trust,
    sourceRef: input.sourceRef,
    precedence: input.precedence,
  };
  try {
    instructionDescriptor(file);
    return file;
  } catch {
    return undefined;
  }
}

function selectCandidate(
  files: ReadonlyMap<string, { path: string; bytes: Uint8Array }>,
): { path: string; bytes: Uint8Array } | undefined {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    const hit = files.get(name);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

function blockedPrefixes(nodes: readonly SnapshotNode[]): Set<string> {
  const blocked = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "symlink" || node.kind === "submodule") {
      if (isSafeSnapshotPath(node.path)) {
        blocked.add(nfc(node.path));
      }
    }
  }
  return blocked;
}

function findWorktreeShadows(
  nodes: readonly SnapshotNode[],
  files: readonly DiscoveredContextFile[],
): WorktreeShadow[] {
  const gitFiles = nodes.filter(
    (node) => node.kind === "file" && posixBasename(node.path) === ".git" && posixDirname(node.path) !== ".",
  );
  const shadows: WorktreeShadow[] = [];
  for (const gitFile of gitFiles) {
    const worktreeRoot = posixDirname(gitFile.path);
    const selected = files.find((file) => file.scope === worktreeRoot);
    if (selected === undefined) {
      continue;
    }
    shadows.push({
      worktreeRoot,
      filename: selected.filename,
      shadowedPath: selected.filename,
    });
  }
  return shadows;
}

function instructionId(raw: string): string {
  const normalized = nfc(raw);
  if (Buffer.byteLength(normalized, "utf8") <= 256) {
    return normalized;
  }
  return `instr-${sha256Hex(Buffer.from(normalized, "utf8")).slice("sha256:".length, 16 + "sha256:".length)}`;
}

function compareScope(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left === ".") {
    return -1;
  }
  if (right === ".") {
    return 1;
  }
  const leftDepth = left.split("/").length;
  const rightDepth = right.split("/").length;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }
  return left < right ? -1 : 1;
}

function parseYamlMap(block: string): YamlMap {
  const lines = block.split("\n");
  const { value, next } = parseYamlValue(lines, 0, 0);
  if (next < lines.length && lines.slice(next).some((line) => line.trim() !== "")) {
    throw new Error("unexpected trailing yaml");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frontmatter must be a mapping");
  }
  return value;
}

function parseYamlValue(
  lines: readonly string[],
  index: number,
  indent: number,
): { value: YamlValue; next: number } {
  const line = lines[index];
  if (line === undefined) {
    return { value: {}, next: index };
  }
  if (isListLine(line, indent)) {
    return parseYamlList(lines, index, indent);
  }
  return parseYamlMapping(lines, index, indent);
}

function parseYamlMapping(
  lines: readonly string[],
  start: number,
  indent: number,
): { value: YamlMap; next: number } {
  const result: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim() === "" || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    const currentIndent = leadingSpaces(line);
    if (currentIndent < indent) {
      break;
    }
    if (currentIndent > indent) {
      throw new Error("invalid yaml indent");
    }
    const trimmed = line.slice(indent);
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (match === null) {
      throw new Error(`invalid yaml line: ${trimmed}`);
    }
    const key = match[1] ?? "";
    const remainder = (match[2] ?? "").trim();
    index += 1;
    if (remainder.length === 0) {
      const nextLine = peekSignificant(lines, index);
      if (nextLine !== undefined && leadingSpaces(nextLine.line) > indent) {
        const nested = parseYamlValue(lines, index, leadingSpaces(nextLine.line));
        result[key] = nested.value;
        index = nested.next;
      } else {
        result[key] = "";
      }
      continue;
    }
    result[key] = parseScalar(remainder);
  }
  return { value: result, next: index };
}

function parseYamlList(
  lines: readonly string[],
  start: number,
  indent: number,
): { value: YamlValue[]; next: number } {
  const items: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") {
      index += 1;
      continue;
    }
    const currentIndent = leadingSpaces(line);
    if (currentIndent < indent || !isListLine(line, indent)) {
      break;
    }
    const remainder = line.slice(indent + 1).trim();
    index += 1;
    if (remainder.length === 0) {
      const nextLine = peekSignificant(lines, index);
      if (nextLine !== undefined && leadingSpaces(nextLine.line) > indent) {
        const nested = parseYamlValue(lines, index, leadingSpaces(nextLine.line));
        items.push(nested.value);
        index = nested.next;
      } else {
        items.push("");
      }
      continue;
    }
    if (remainder.includes(":") && !remainder.startsWith("'") && !remainder.startsWith('"')) {
      const nested = parseYamlMapping([`${" ".repeat(indent + 2)}${remainder}`, ...lines.slice(index)], 0, indent + 2);
      items.push(nested.value);
      continue;
    }
    items.push(parseScalar(remainder));
  }
  return { value: items, next: index };
}

function isListLine(line: string, indent: number): boolean {
  return leadingSpaces(line) === indent && line.slice(indent).startsWith("- ");
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function peekSignificant(
  lines: readonly string[],
  start: number,
): { line: string; index: number } | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && line.trim() !== "" && !line.trimStart().startsWith("#")) {
      return { line, index };
    }
  }
  return undefined;
}

function parseScalar(raw: string): YamlValue {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null" || raw === "~") {
    return "";
  }
  if (/^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}
