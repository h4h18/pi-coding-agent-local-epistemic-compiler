import { Compile } from "typebox/compile";
import {
  SkillDescriptorSchema,
  sha256Hex,
  type Digest,
  type ObjectDigest,
  type SkillDescriptor,
  type SkillManifest,
  type SnapshotId,
  type SourceRef,
} from "@pi-hec/contracts";
import {
  artifactSourceRef,
  asUtf8,
  isPathInsideRoot,
  isSafeSnapshotPath,
  nfc,
  parseYamlFrontmatter,
  pathHasBlockedAncestor,
  posixBasename,
  posixDirname,
  posixJoin,
  repositorySourceRef,
  yamlMap,
  yamlStringList,
  type SnapshotNode,
  type TrustLabel,
  type YamlValue,
} from "./context-discovery.js";

const SKILL_DESCRIPTOR = Compile(SkillDescriptorSchema);
const EXECUTABLE_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".ps1",
  ".cmd",
  ".bat",
  ".exe",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".php",
  ".pl",
  ".ts",
  ".com",
  ".vbs",
  ".wsf",
]);

export type ExternalSkillSource = {
  trust: "platform" | "user";
  files: readonly {
    path: string;
    bytes: Uint8Array;
    artifactObjectDigest?: ObjectDigest;
  }[];
};

export type DiscoveredSkill = {
  descriptor: SkillDescriptor;
  body: string;
  bytes: Uint8Array;
  dependencies: readonly string[];
  pathScope: string;
  trust: TrustLabel;
};

export type SkillDiscoveryInput = {
  snapshotId: SnapshotId;
  nodes: readonly SnapshotNode[];
  projectTrusted: boolean;
  configuredRoots?: readonly string[];
  trustedPackageRoots?: readonly string[];
  globalSkills?: readonly ExternalSkillSource[];
};

export type SkillDiscoveryResult = {
  skills: readonly DiscoveredSkill[];
  conflicts: SkillManifest["conflicts"];
};

type FileRecord = { path: string; bytes: Uint8Array };

type CandidateSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  bytes: Uint8Array;
  body: string;
  dependencies: string[];
  pathScope: string;
  loadPolicy: SkillDescriptor["loadPolicy"];
  trust: TrustLabel;
  sourceRef: SourceRef;
  executableAssets: SourceRef[];
  contentDigest: Digest;
};

type CollectInput = {
  snapshotId: SnapshotId;
  trust: TrustLabel;
  files: ReadonlyMap<string, FileRecord>;
  candidates: CandidateSkill[];
  parseConflicts: SkillManifest["conflicts"];
  external?: boolean;
  artifactKind?: "user-task" | "platform-policy";
};

export function discoverSkills(input: SkillDiscoveryInput): SkillDiscoveryResult {
  const files = indexFiles(input.nodes);
  const candidates: CandidateSkill[] = [];
  const parseConflicts: SkillManifest["conflicts"] = [];

  collectTreeSkills({
    root: ".pi/skills",
    files,
    includeRootMarkdown: true,
    includeNestedMarkdown: false,
    snapshotId: input.snapshotId,
    trust: projectTrust(input.projectTrusted),
    candidates,
    parseConflicts,
  });
  collectTreeSkills({
    root: ".agents/skills",
    files,
    includeRootMarkdown: false,
    includeNestedMarkdown: true,
    snapshotId: input.snapshotId,
    trust: projectTrust(input.projectTrusted),
    candidates,
    parseConflicts,
  });

  for (const rawRoot of input.configuredRoots ?? []) {
    const root = nfc(rawRoot).replace(/\/+$/, "");
    if (!isSafeSnapshotPath(root)) {
      continue;
    }
    collectTreeSkills({
      root,
      files,
      includeRootMarkdown: true,
      includeNestedMarkdown: false,
      snapshotId: input.snapshotId,
      trust: projectTrust(input.projectTrusted),
      candidates,
      parseConflicts,
    });
  }

  for (const packageRoot of input.trustedPackageRoots ?? []) {
    if (!isSafeSnapshotPath(packageRoot)) {
      continue;
    }
    for (const skillRoot of packageSkillRoots(packageRoot, files)) {
      collectTreeSkills({
        root: skillRoot,
        files,
        includeRootMarkdown: true,
        includeNestedMarkdown: false,
        snapshotId: input.snapshotId,
        trust: projectTrust(input.projectTrusted),
        candidates,
        parseConflicts,
      });
    }
  }

  for (const source of input.globalSkills ?? []) {
    const globalFiles = new Map<string, FileRecord>();
    for (const file of source.files) {
      if (!isSafeSnapshotPath(file.path)) {
        continue;
      }
      globalFiles.set(nfc(file.path), { path: nfc(file.path), bytes: file.bytes });
    }
    for (const root of skillRootsFromFiles(globalFiles)) {
      collectTreeSkills({
        root,
        files: globalFiles,
        includeRootMarkdown: true,
        includeNestedMarkdown: false,
        snapshotId: input.snapshotId,
        trust: source.trust,
        candidates,
        parseConflicts,
        external: true,
        artifactKind: source.trust === "platform" ? "platform-policy" : "user-task",
      });
    }
  }

  return finalizeSkills(candidates, parseConflicts);
}

export function skillAliasKey(name: string): string {
  return nfc(name).toLocaleLowerCase("en-US");
}

function projectTrust(projectTrusted: boolean): TrustLabel {
  return projectTrusted ? "trusted-project" : "untrusted-data";
}

function indexFiles(nodes: readonly SnapshotNode[]): Map<string, FileRecord> {
  const blocked = new Set<string>();
  for (const node of nodes) {
    if ((node.kind === "symlink" || node.kind === "submodule") && isSafeSnapshotPath(node.path)) {
      blocked.add(nfc(node.path));
    }
  }
  const files = new Map<string, FileRecord>();
  for (const node of nodes) {
    if (node.kind !== "file" || !isSafeSnapshotPath(node.path)) {
      continue;
    }
    const path = nfc(node.path);
    if (pathHasBlockedAncestor(path, blocked)) {
      continue;
    }
    files.set(path, { path, bytes: node.bytes });
  }
  return files;
}

function collectTreeSkills(input: {
  root: string;
  files: ReadonlyMap<string, FileRecord>;
  includeRootMarkdown: boolean;
  includeNestedMarkdown: boolean;
  snapshotId: SnapshotId;
  trust: TrustLabel;
  candidates: CandidateSkill[];
  parseConflicts: SkillManifest["conflicts"];
  external?: boolean;
  artifactKind?: "user-task" | "platform-policy";
}): void {
  const skillMd = [...input.files.keys()]
    .filter((path) => isPathInsideRoot(input.root, path) && posixBasename(path) === "SKILL.md")
    .sort();
  const claimed = new Set<string>();
  for (const path of skillMd) {
    if (hasShallowerSkill(path, skillMd)) {
      continue;
    }
    claimed.add(posixDirname(path));
    pushParsedSkill({
      file: mustGet(input.files, path),
      declared: true,
      skillDir: posixDirname(path),
      input,
    });
  }

  const sortedPaths = [...input.files.keys()].sort();
  for (const path of sortedPaths) {
    const file = mustGet(input.files, path);
    if (!isPathInsideRoot(input.root, path) || posixBasename(path) === "SKILL.md") {
      continue;
    }
    if (!path.endsWith(".md")) {
      continue;
    }
    const dir = posixDirname(path);
    const atRoot = dir === input.root;
    if (atRoot && !input.includeRootMarkdown) {
      continue;
    }
    if (!atRoot && !input.includeNestedMarkdown) {
      continue;
    }
    if (directoryClaimed(dir, claimed)) {
      continue;
    }
    pushParsedSkill({ file, declared: false, skillDir: dir, input });
  }
}

function pushParsedSkill(args: {
  file: FileRecord;
  declared: boolean;
  skillDir: string;
  input: CollectInput;
}): void {
  const text = asUtf8(args.file.bytes);
  if (text.length === 0) {
    return;
  }
  const parsed = parseYamlFrontmatter(text);
  if ("error" in parsed) {
    if (args.declared) {
      args.input.parseConflicts.push({
        skillIds: [fallbackSkillId(args.file.path)],
        sourceRefs: [sourceFor(args)],
        reason: `malformed SKILL.md frontmatter at ${args.file.path}: ${parsed.error}`,
      });
    }
    return;
  }
  const descriptionRaw = parsed.fields.description;
  const description = typeof descriptionRaw === "string" ? descriptionRaw.trim() : "";
  if (description.length === 0) {
    if (args.declared) {
      args.input.parseConflicts.push({
        skillIds: [fallbackSkillId(args.file.path)],
        sourceRefs: [sourceFor(args)],
        reason: `SKILL.md at ${args.file.path} is missing a description`,
      });
    }
    return;
  }
  const frontmatterName = typeof parsed.fields.name === "string" ? parsed.fields.name : undefined;
  const name = nfc(frontmatterName ?? posixBasename(args.skillDir));
  const depends = [
    ...yamlStringList(parsed.fields.depends),
    ...yamlStringList(parsed.fields.dependencies),
    ...yamlStringList(yamlMap(parsed.fields.metadata).depends),
  ].map((item) => nfc(item));
  const scopeRaw = parsed.fields.scope;
  const pathScope = typeof scopeRaw === "string" && scopeRaw.length > 0 ? nfc(scopeRaw) : ".";
  const bytes = args.file.bytes;
  args.input.candidates.push({
    id: name,
    name,
    description,
    path: args.file.path,
    bytes,
    body: text,
    dependencies: depends,
    pathScope,
    loadPolicy: parseLoadPolicy(parsed.fields.loadPolicy),
    trust: args.input.trust,
    sourceRef: sourceFor(args),
    executableAssets: executableAssetRefs(
      args.skillDir,
      args.file.path,
      args.input.files,
      args.input.snapshotId,
      args.input.external === true,
      args.input.artifactKind,
    ),
    contentDigest: sha256Hex(bytes),
  });
}

function finalizeSkills(
  candidates: readonly CandidateSkill[],
  parseConflicts: SkillManifest["conflicts"],
): SkillDiscoveryResult {
  const groups = new Map<string, CandidateSkill[]>();
  for (const candidate of candidates) {
    const key = skillAliasKey(candidate.name);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const skills: DiscoveredSkill[] = [];
  const conflicts: SkillManifest["conflicts"] = [...parseConflicts];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (group === undefined || group.length === 0) {
      continue;
    }
    const names = new Set(group.map((item) => nfc(item.name)));
    if (group.length > 1) {
      conflicts.push({
        skillIds: group.map((item) => item.id),
        sourceRefs: group.map((item) => item.sourceRef),
        reason:
          names.size === 1
            ? `duplicate skill id ${group[0]?.name ?? key}`
            : `case/Unicode alias collision for skill id ${key}`,
      });
      continue;
    }
    const candidate = group[0];
    if (candidate === undefined) {
      continue;
    }
    if (!isValidSkillName(candidate.name) || !isSafeScope(candidate.pathScope)) {
      conflicts.push({
        skillIds: [candidate.id],
        sourceRefs: [candidate.sourceRef],
        reason: `invalid skill name or scope for ${candidate.path}`,
      });
      continue;
    }
    const descriptor: SkillDescriptor = {
      id: candidate.id,
      name: candidate.name,
      description: candidate.description,
      sourceRef: candidate.sourceRef,
      scope: candidate.pathScope,
      contentDigest: candidate.contentDigest,
      loadPolicy: candidate.loadPolicy,
      executableAssets: candidate.executableAssets,
    };
    if (!SKILL_DESCRIPTOR.Check(descriptor)) {
      conflicts.push({
        skillIds: [candidate.id],
        sourceRefs: [candidate.sourceRef],
        reason: `skill descriptor schema invalid for ${candidate.path}`,
      });
      continue;
    }
    skills.push({
      descriptor,
      body: candidate.body,
      bytes: candidate.bytes,
      dependencies: candidate.dependencies,
      pathScope: candidate.pathScope,
      trust: candidate.trust,
    });
  }
  skills.sort((left, right) => (left.descriptor.id < right.descriptor.id ? -1 : 1));
  return { skills, conflicts };
}

function packageSkillRoots(packageRoot: string, files: ReadonlyMap<string, FileRecord>): string[] {
  const manifest = files.get(posixJoin(packageRoot, "package.json"));
  if (manifest === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(asUtf8(manifest.bytes));
    if (!isJsonRecord(parsed)) {
      return [];
    }
    const piValue = parsed.pi;
    if (isJsonRecord(piValue) && Array.isArray(piValue.skills)) {
      return piValue.skills
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizePackageSkillPath(packageRoot, item))
        .filter((item): item is string => item !== undefined);
    }
  } catch {
    return [];
  }
  const convention = posixJoin(packageRoot, "skills");
  return [...files.keys()].some((path) => isPathInsideRoot(convention, path)) ? [convention] : [];
}

function normalizePackageSkillPath(packageRoot: string, raw: string): string | undefined {
  const trimmed = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    return undefined;
  }
  const joined = posixJoin(packageRoot, trimmed);
  return isSafeSnapshotPath(joined) ? joined : undefined;
}

function skillRootsFromFiles(files: ReadonlyMap<string, FileRecord>): string[] {
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    dirs.add(posixDirname(path));
  }
  return [...dirs].sort();
}

function hasShallowerSkill(skillMdPath: string, all: readonly string[]): boolean {
  let cursor = posixDirname(skillMdPath);
  while (cursor !== ".") {
    const parent = posixDirname(cursor);
    if (parent === cursor) {
      break;
    }
    if (all.includes(posixJoin(parent, "SKILL.md"))) {
      return true;
    }
    cursor = parent;
  }
  return false;
}

function directoryClaimed(dir: string, claimed: ReadonlySet<string>): boolean {
  let cursor = dir;
  for (;;) {
    if (claimed.has(cursor)) {
      return true;
    }
    if (cursor === ".") {
      return false;
    }
    const next = posixDirname(cursor);
    if (next === cursor) {
      return false;
    }
    cursor = next;
  }
}

function executableAssetRefs(
  skillDir: string,
  skillFile: string,
  files: ReadonlyMap<string, FileRecord>,
  snapshotId: SnapshotId,
  external: boolean,
  artifactKind: "user-task" | "platform-policy" | undefined,
): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const file of files.values()) {
    if (file.path === skillFile || !isPathInsideRoot(skillDir, file.path)) {
      continue;
    }
    const base = posixBasename(file.path);
    const dot = base.lastIndexOf(".");
    const ext = dot === -1 ? "" : base.slice(dot).toLowerCase();
    if (!file.path.includes("/scripts/") && !EXECUTABLE_EXTENSIONS.has(ext)) {
      continue;
    }
    refs.push(
      external
        ? artifactSourceRef({
            bytes: file.bytes,
            sourceKind: artifactKind ?? "user-task",
          })
        : repositorySourceRef({
            snapshotId,
            path: file.path,
            bytes: file.bytes,
            sourceKind: "repository",
          }),
    );
  }
  refs.sort((left, right) => sourcePath(left).localeCompare(sourcePath(right)));
  return refs;
}

function sourcePath(ref: SourceRef): string {
  return ref.origin === "repository" ? ref.path : ref.artifactObjectDigest;
}

function sourceFor(args: { file: FileRecord; input: CollectInput }): SourceRef {
  if (args.input.external === true) {
    return artifactSourceRef({
      bytes: args.file.bytes,
      sourceKind: args.input.artifactKind ?? "user-task",
    });
  }
  return repositorySourceRef({
    snapshotId: args.input.snapshotId,
    path: args.file.path,
    bytes: args.file.bytes,
    sourceKind: "repository",
  });
}

function parseLoadPolicy(value: YamlValue | undefined): SkillDescriptor["loadPolicy"] {
  if (value === "mandatory" || value === "applicable" || value === "on-request") {
    return value;
  }
  return "on-request";
}

function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function isSafeScope(scope: string): boolean {
  return scope === "." || isSafeSnapshotPath(scope);
}

function isJsonRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fallbackSkillId(path: string): string {
  const digest = sha256Hex(Buffer.from(path, "utf8"));
  return `skill-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
}

function mustGet(files: ReadonlyMap<string, FileRecord>, path: string): FileRecord {
  const file = files.get(path);
  if (file === undefined) {
    throw new Error(`missing skill file ${path}`);
  }
  return file;
}
