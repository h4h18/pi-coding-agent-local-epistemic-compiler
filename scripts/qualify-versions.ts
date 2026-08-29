import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LockEntry = {
  version: string;
  resolvedAt: string;
  sourceUrl: string;
};

export type RejectedLockEntry = LockEntry & {
  reason: string;
};

export type VersionsLock = {
  packages: Record<string, LockEntry>;
  discoveredRejected: Record<string, RejectedLockEntry>;
};

export type QualifyIssue = {
  message: string;
};

export type QualifyReport = {
  ok: boolean;
  issues: QualifyIssue[];
};

export const QUALIFIED_EXACT: Readonly<Record<string, string>> = {
  node: "24.20.0",
  pnpm: "12.0.0",
  typescript: "6.0.3",
  typebox: "1.3.19",
  fastify: "5.12.1",
  "@fastify/type-provider-typebox": "6.1.0",
  "better-sqlite3": "13.0.3",
  "@earendil-works/pi-coding-agent": "0.84.3",
  "@earendil-works/pi-ai": "0.84.3",
  "@earendil-works/pi-tui": "0.84.3",
  "@earendil-works/pi-agent-core": "0.84.3",
  vitest: "4.1.11",
  "fast-check": "4.9.0",
  eslint: "10.9.1",
  "typescript-eslint": "8.68.0",
  prettier: "3.9.6",
  pino: "10.3.1",
  "sqlite-vec": "0.1.9",
  "@types/node": "24.13.3",
  rustc: "1.98.0",
  "cargo-nextest": "0.9.143",
};

const QUALIFIED_NAMES = Object.keys(QUALIFIED_EXACT);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const NODE_FLOOR = { major: 24, minor: 20, patch: 0 } as const;

const RESOLVE_USER_AGENT = "pi-hec-qualify-versions/0.0.0";

const NODE_DIST_INDEX_URL = "https://nodejs.org/dist/index.json";
const RUST_STABLE_CHANNEL_URL = "https://static.rust-lang.org/dist/channel-rust-stable.toml";
const CARGO_NEXTEST_URL = "https://crates.io/api/v1/crates/cargo-nextest";

type Semver = { major: number; minor: number; patch: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSemver(version: string): Semver | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const majorText = match?.[1];
  const minorText = match?.[2];
  const patchText = match?.[3];
  if (majorText === undefined || minorText === undefined || patchText === undefined) {
    return undefined;
  }
  return {
    major: Number(majorText),
    minor: Number(minorText),
    patch: Number(patchText),
  };
}

function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function maxSemver(versions: readonly string[]): string | undefined {
  let best: { version: string; parsed: Semver } | undefined;
  for (const version of versions) {
    const parsed = parseSemver(version);
    if (parsed === undefined) {
      continue;
    }
    if (best === undefined || compareSemver(parsed, best.parsed) > 0) {
      best = { version, parsed };
    }
  }
  return best?.version;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readLockEntry(
  name: string,
  value: unknown,
  issues: QualifyIssue[],
): LockEntry | undefined {
  if (!isRecord(value)) {
    issues.push({ message: `${name} must be an object with version, resolvedAt, sourceUrl` });
    return undefined;
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    issues.push({ message: `${name}.version must be a non-empty string` });
    return undefined;
  }
  if (typeof value.resolvedAt !== "string" || !ISO_UTC.test(value.resolvedAt)) {
    issues.push({ message: `${name}.resolvedAt must be an ISO-8601 UTC timestamp` });
    return undefined;
  }
  if (typeof value.sourceUrl !== "string" || !isHttpUrl(value.sourceUrl)) {
    issues.push({ message: `${name}.sourceUrl must be an http(s) URL` });
    return undefined;
  }
  return {
    version: value.version,
    resolvedAt: value.resolvedAt,
    sourceUrl: value.sourceUrl,
  };
}

function assertExactPin(name: string, version: string, issues: QualifyIssue[]): Semver | undefined {
  const parsed = parseSemver(version);
  if (parsed === undefined) {
    issues.push({ message: `${name} version ${version} is not an exact x.y.z pin` });
    return undefined;
  }
  return parsed;
}

function assertNodeIsLts24NotCurrent(version: string, issues: QualifyIssue[]): void {
  const parsed = parseSemver(version);
  if (parsed === undefined) {
    issues.push({ message: `node version ${version} is not a valid x.y.z pin` });
    return;
  }
  if (parsed.major === 25 || parsed.major === 26) {
    issues.push({
      message: `Node pin ${version} is Current 25/26; refuse Node 25/26 and keep 24.x LTS (floor 24.20.0)`,
    });
    return;
  }
  if (parsed.major !== 24) {
    issues.push({
      message: `Node pin ${version} is not 24.x LTS; refuse Node 25/26 and keep 24.x LTS (floor 24.20.0)`,
    });
    return;
  }
  if (
    parsed.minor < NODE_FLOOR.minor ||
    (parsed.minor === NODE_FLOOR.minor && parsed.patch < NODE_FLOOR.patch)
  ) {
    issues.push({
      message: `Node pin ${version} is below floor 24.20.0`,
    });
  }
}

function assertTypesNodeIs24Not26(version: string, issues: QualifyIssue[]): void {
  const parsed = parseSemver(version);
  if (parsed === undefined) {
    issues.push({ message: `@types/node version ${version} is not a valid x.y.z pin` });
    return;
  }
  if (parsed.major === 25 || parsed.major === 26) {
    issues.push({
      message: `@types/node pin ${version} is 26.x/Current; keep 24.x not 26`,
    });
    return;
  }
  if (parsed.major !== 24) {
    issues.push({
      message: `@types/node pin ${version} is not 24.x; keep 24.x not 26`,
    });
  }
}

export function qualifyLockfile(lockfile: unknown): QualifyIssue[] {
  const issues: QualifyIssue[] = [];
  if (!isRecord(lockfile)) {
    return [{ message: "versions.lock.json must be an object" }];
  }
  if (!isRecord(lockfile.packages)) {
    issues.push({ message: "packages must be an object" });
    return issues;
  }
  if (!isRecord(lockfile.discoveredRejected)) {
    issues.push({ message: "discoveredRejected must be an object" });
    return issues;
  }

  for (const [name, expected] of Object.entries(QUALIFIED_EXACT)) {
    const entry = readLockEntry(name, lockfile.packages[name], issues);
    if (entry === undefined) {
      continue;
    }
    const parsed = assertExactPin(name, entry.version, issues);
    if (entry.version !== expected) {
      issues.push({
        message: `${name} version ${entry.version} does not match qualified exact ${expected}`,
      });
    }
    if (name === "node") {
      assertNodeIsLts24NotCurrent(entry.version, issues);
    }
    if (name === "@types/node") {
      assertTypesNodeIs24Not26(entry.version, issues);
    }
    if (name === "typescript") {
      if (parsed !== undefined && parsed.major >= 7) {
        issues.push({
          message: `typescript ${entry.version} has no programmatic compiler API; keep 6.0.x and record 7.x in discoveredRejected`,
        });
      }
    }
  }

  const rejectedTs = lockfile.discoveredRejected.typescript;
  const rejectedEntry = readLockEntry("discoveredRejected.typescript", rejectedTs, issues);
  if (isRecord(rejectedTs) && typeof rejectedTs.reason !== "string") {
    issues.push({ message: "discoveredRejected.typescript.reason must be a string" });
  }
  if (rejectedEntry !== undefined && rejectedEntry.version !== "7.0.2") {
    issues.push({
      message: `discoveredRejected.typescript must record TypeScript 7.0.2, found ${rejectedEntry.version}`,
    });
  }

  const piNames = [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-agent-core",
  ] as const;
  const piVersions = new Set<string>();
  for (const name of piNames) {
    const entry = lockfile.packages[name];
    if (isRecord(entry) && typeof entry.version === "string") {
      piVersions.add(entry.version);
    }
  }
  if (piVersions.size > 1) {
    issues.push({
      message: `@earendil-works/pi-* versions differ: ${[...piVersions].join(", ")}`,
    });
  }

  return issues;
}

type NodeDistRelease = {
  version: string;
  lts: string | false;
};

function parseNodeDist(value: unknown): NodeDistRelease[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const releases: NodeDistRelease[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.version !== "string") {
      continue;
    }
    const lts = item.lts === false || typeof item.lts === "string" ? item.lts : false;
    releases.push({ version: item.version, lts });
  }
  return releases;
}

function parseNpmDistTags(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value["dist-tags"])) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value["dist-tags"]).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseNpmVersionKeys(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.versions)) {
    return [];
  }
  return Object.keys(value.versions);
}

function stripNodeV(version: string): string {
  return version.replace(/^v/, "");
}

function resolveNodeLts24Krypton(releases: readonly NodeDistRelease[]): {
  version: string | undefined;
  refusedCurrent: string | undefined;
} {
  let refusedCurrent: string | undefined;
  let krypton24: string | undefined;
  let any24: string | undefined;
  for (const release of releases) {
    const version = stripNodeV(release.version);
    const parsed = parseSemver(version);
    if (parsed === undefined) {
      continue;
    }
    if (parsed.major === 25 || parsed.major === 26) {
      refusedCurrent ??= version;
      continue;
    }
    if (parsed.major !== 24) {
      continue;
    }
    any24 ??= version;
    if (release.lts === "Krypton" || (typeof release.lts === "string" && release.lts.length > 0)) {
      krypton24 ??= version;
    }
  }
  return { version: krypton24 ?? any24, refusedCurrent };
}

function isNumberedStable12Tag(tag: string): boolean {
  return /^(?:latest|next)-12$/.test(tag) || /^12(?:\.\d+)*$/.test(tag);
}

function resolvePnpm(tags: Record<string, string>): string | undefined {
  const numbered12 = Object.entries(tags)
    .filter(([tag, version]) => isNumberedStable12Tag(tag) && parseSemver(version)?.major === 12)
    .map(([, version]) => version);
  const numberedBest = maxSemver(numbered12);
  if (numberedBest !== undefined) {
    return numberedBest;
  }
  const any12 = maxSemver(
    Object.values(tags).filter((version) => parseSemver(version)?.major === 12),
  );
  if (any12 !== undefined) {
    return any12;
  }
  return tags.latest;
}

function resolveTypesNode24(packument: unknown): string | undefined {
  return maxSemver(
    parseNpmVersionKeys(packument).filter((version) => parseSemver(version)?.major === 24),
  );
}

function parseRustcChannelVersion(toml: string): string | undefined {
  for (const pkg of ["rustc", "rust"] as const) {
    const header = `[pkg.${pkg}]`;
    const start = toml.indexOf(header);
    if (start < 0) {
      continue;
    }
    const rest = toml.slice(start + header.length);
    const nextSection = rest.search(/\n\[/);
    const body = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
    const match = /^version\s*=\s*"(\d+\.\d+\.\d+)/m.exec(body);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

function parseCargoNextestVersion(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.crate)) {
    return undefined;
  }
  if (typeof value.crate.max_stable_version === "string") {
    return value.crate.max_stable_version;
  }
  if (typeof value.crate.max_version === "string") {
    return value.crate.max_version;
  }
  return undefined;
}

function npmPackumentUrl(name: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(name)}`;
}

function resolveNpmPackage(name: string, packument: unknown): string | undefined {
  if (name === "pnpm") {
    return resolvePnpm(parseNpmDistTags(packument));
  }
  if (name === "@types/node") {
    return resolveTypesNode24(packument);
  }
  return parseNpmDistTags(packument).latest;
}

export async function reResolveFloors(
  fetchImpl: typeof fetch,
): Promise<Record<string, string | undefined>> {
  const headers = { "User-Agent": RESOLVE_USER_AGENT };
  const npmNames = QUALIFIED_NAMES.filter(
    (name) => name !== "node" && name !== "rustc" && name !== "cargo-nextest",
  );
  const fetchOne = (url: string): Promise<Response> => fetchImpl(url, { headers });

  const nodePromise = fetchOne(NODE_DIST_INDEX_URL);
  const rustPromise = fetchOne(RUST_STABLE_CHANNEL_URL);
  const nextestPromise = fetchOne(CARGO_NEXTEST_URL);
  const npmFetches = npmNames.map((name) => ({
    name,
    response: fetchOne(npmPackumentUrl(name)),
  }));

  const [nodeRes, rustRes, nextestRes, ...npmResponses] = await Promise.all([
    nodePromise,
    rustPromise,
    nextestPromise,
    ...npmFetches.map((item) => item.response),
  ]);

  if (!nodeRes.ok) {
    throw new Error(`failed to fetch Node dist index: ${String(nodeRes.status)}`);
  }
  if (!nextestRes.ok) {
    throw new Error(`failed to fetch cargo-nextest from crates.io: ${String(nextestRes.status)}`);
  }

  const resolved: Record<string, string | undefined> = {};
  const nodePick = resolveNodeLts24Krypton(parseNodeDist(await nodeRes.json()));
  resolved.node = nodePick.version;
  if (nodePick.version === undefined && nodePick.refusedCurrent !== undefined) {
    resolved.node = nodePick.refusedCurrent;
  }

  resolved["cargo-nextest"] = parseCargoNextestVersion(await nextestRes.json());

  // rustc: fetch rust-lang stable channel when feasible. If the response is not
  // usable, skip the network pin and compare the lockfile against QUALIFIED_EXACT.
  if (rustRes.ok) {
    resolved.rustc = parseRustcChannelVersion(await rustRes.text());
  }

  for (let index = 0; index < npmNames.length; index += 1) {
    const name = npmNames[index];
    const response = npmResponses[index];
    if (name === undefined || response === undefined) {
      continue;
    }
    if (!response.ok) {
      throw new Error(`failed to fetch ${name} packument: ${String(response.status)}`);
    }
    resolved[name] = resolveNpmPackage(name, await response.json());
  }

  return resolved;
}

function applyResolvedFloors(
  resolved: Record<string, string | undefined>,
  lockfile: unknown,
  issues: QualifyIssue[],
): void {
  for (const name of QUALIFIED_NAMES) {
    const version = resolved[name];
    if (name === "rustc" && version === undefined) {
      continue;
    }
    if (version === undefined) {
      issues.push({ message: `re-resolve did not obtain a version for ${name}` });
      continue;
    }
    if (name === "node") {
      assertNodeIsLts24NotCurrent(version, issues);
      continue;
    }
    if (name === "@types/node") {
      assertTypesNodeIs24Not26(version, issues);
      continue;
    }
    if (name === "typescript") {
      const parsed = parseSemver(version);
      if (parsed !== undefined && parsed.major >= 7) {
        if (!isRecord(lockfile) || !isRecord(lockfile.discoveredRejected)) {
          issues.push({
            message: `re-resolve found typescript ${version}; discoveredRejected is missing`,
          });
        }
      }
    }
  }
}

export async function qualifyVersions(options: {
  lockPath: string;
  resolveFromNetwork?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<QualifyReport> {
  const raw: unknown = JSON.parse(readFileSync(options.lockPath, "utf8"));
  const issues = qualifyLockfile(raw);
  if (options.resolveFromNetwork === true) {
    const resolved = await reResolveFloors(options.fetchImpl ?? fetch);
    applyResolvedFloors(resolved, raw, issues);
  }
  return { ok: issues.length === 0, issues };
}

function isExecutedAsCli(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.normalize(fileURLToPath(metaUrl)) === path.normalize(path.resolve(entry));
}

async function main(): Promise<void> {
  const resolveFromNetwork = process.argv.includes("--resolve");
  const lockPath = path.resolve("config/versions.lock.json");
  const report = await qualifyVersions({ lockPath, resolveFromNetwork });
  for (const item of report.issues) {
    console.error(item.message);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (isExecutedAsCli(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
