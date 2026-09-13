import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCargoGraph } from "./check-cargo-graph.ts";

export type GraphIssueKind =
  | "forbidden-edge"
  | "cycle"
  | "ranged-version"
  | "pi-version-mismatch"
  | "banned-package"
  | "domain-forbidden-dep";

export type GraphIssue = {
  kind: GraphIssueKind;
  message: string;
};

export type GraphReport = {
  ok: boolean;
  issues: GraphIssue[];
};

const APP_PACKAGES: ReadonlySet<string> = new Set([
  "@pi-hec/control-plane",
  "@pi-hec/context-worker",
  "@pi-hec/verification-worker",
  "@pi-hec/secret-broker",
  "@pi-hec/pi-extension",
]);

const PRODUCER_TO_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "@pi-hec/contracts": [
    "@pi-hec/domain",
    "@pi-hec/cas",
    "@pi-hec/security",
    "@pi-hec/client",
    "@pi-hec/repository",
    "@pi-hec/instructions",
    "@pi-hec/evidence",
    "@pi-hec/models",
    "@pi-hec/sandbox",
    "@pi-hec/verification",
    "@pi-hec/preflight",
    "@pi-hec/context-compiler",
    "@pi-hec/cloud-gateway",
    "@pi-hec/usage",
    "@pi-hec/test-support",
    "@pi-hec/agent-runtime",
  ],
  "@pi-hec/domain": [
    "@pi-hec/state-store",
    "@pi-hec/evidence",
    "@pi-hec/verification",
    "@pi-hec/preflight",
    "@pi-hec/agent-runtime",
  ],
  "@pi-hec/cas": ["@pi-hec/repository", "@pi-hec/context-compiler"],
  "@pi-hec/security": [
    "@pi-hec/sandbox",
    "@pi-hec/verification",
    "@pi-hec/context-compiler",
    "@pi-hec/cloud-gateway",
  ],
  "@pi-hec/repository": [
    "@pi-hec/instructions",
    "@pi-hec/evidence",
    "@pi-hec/verification",
    "@pi-hec/preflight",
  ],
  "@pi-hec/instructions": ["@pi-hec/verification", "@pi-hec/preflight", "@pi-hec/context-compiler"],
  "@pi-hec/evidence": ["@pi-hec/verification", "@pi-hec/preflight", "@pi-hec/context-compiler"],
  "@pi-hec/models": [
    "@pi-hec/preflight",
    "@pi-hec/context-compiler",
    "@pi-hec/cloud-gateway",
    "@pi-hec/agent-runtime",
  ],
  "@pi-hec/sandbox": ["@pi-hec/verification"],
  "@pi-hec/preflight": ["@pi-hec/context-compiler"],
  "@pi-hec/state-store": ["@pi-hec/usage"],
};

const ALLOWED_DEPENDENCIES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const allowed = new Map<string, Set<string>>();
  for (const [producer, consumers] of Object.entries(PRODUCER_TO_CONSUMERS)) {
    for (const consumer of consumers) {
      const deps = allowed.get(consumer) ?? new Set<string>();
      deps.add(producer);
      allowed.set(consumer, deps);
    }
  }
  return allowed;
})();

const BANNED_EXACT = new Set([
  "prometheus",
  "opentelemetry",
  "grafana",
  "prisma",
  "nestjs",
  "inversify",
]);

type WorkspacePackage = {
  name: string;
  dir: string;
  kind: "apps" | "packages";
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  references: string[];
};

type GraphEdge = {
  from: string;
  to: string;
  via: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(readText(filePath)) as unknown;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      record[key] = entry;
    }
  }
  return record;
}

function parseWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^\s*-\s*["']([^"']+)["']\s*$/.exec(line);
    const glob = match?.[1];
    if (glob !== undefined) {
      globs.push(glob);
    }
  }
  return globs.length > 0 ? globs : ["apps/*", "packages/*"];
}

function listImmediateDirectories(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function parseTsconfigReferences(tsconfig: unknown): string[] {
  if (!isRecord(tsconfig) || !Array.isArray(tsconfig.references)) {
    return [];
  }
  const refs: string[] = [];
  for (const ref of tsconfig.references) {
    if (isRecord(ref) && typeof ref.path === "string") {
      refs.push(ref.path);
    }
  }
  return refs;
}

function loadWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const workspaceFile = path.join(rootDir, "pnpm-workspace.yaml");
  const globs = existsSync(workspaceFile)
    ? parseWorkspaceGlobs(readText(workspaceFile))
    : ["apps/*", "packages/*"];
  const packages: WorkspacePackage[] = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      continue;
    }
    const parent = glob.slice(0, -2);
    const kind = parent === "apps" || parent.endsWith("/apps") ? "apps" : "packages";
    for (const dir of listImmediateDirectories(path.join(rootDir, parent))) {
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = parseJsonFile(manifestPath);
      if (!isRecord(manifest) || typeof manifest.name !== "string") {
        continue;
      }
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = existsSync(tsconfigPath) ? parseJsonFile(tsconfigPath) : {};
      packages.push({
        name: manifest.name,
        dir,
        kind,
        dependencies: stringRecord(manifest.dependencies),
        devDependencies: stringRecord(manifest.devDependencies),
        peerDependencies: stringRecord(manifest.peerDependencies),
        references: parseTsconfigReferences(tsconfig),
      });
    }
  }
  return packages;
}

function isBannedPackage(name: string): boolean {
  if (BANNED_EXACT.has(name) || name.startsWith("@opentelemetry/")) {
    return true;
  }
  return name.startsWith("@nestjs/") || name.startsWith("@prisma/") || name.startsWith("@grafana/");
}

function isDomainForbidden(name: string): boolean {
  return (
    name === "fastify" ||
    name.startsWith("@fastify/") ||
    name === "@earendil-works/pi-tui" ||
    name === "qemu" ||
    name.startsWith("@qemu/") ||
    name === "windows"
  );
}

function isRangedVersion(version: string): boolean {
  return /[~^*]/.test(version);
}

function isWorkspaceProtocol(version: string): boolean {
  return version.startsWith("workspace:");
}

function isGraphDependency(name: string, version: string): boolean {
  return name.startsWith("@pi-hec/") || isWorkspaceProtocol(version);
}

function edgeIsAllowed(importer: string, importee: string): boolean {
  if (APP_PACKAGES.has(importee)) {
    return false;
  }
  if (APP_PACKAGES.has(importer)) {
    return importee.startsWith("@pi-hec/") && !APP_PACKAGES.has(importee);
  }
  const allowed = ALLOWED_DEPENDENCIES.get(importer);
  return allowed !== undefined && allowed.has(importee);
}

function collectManifestEdges(pkg: WorkspacePackage): GraphEdge[] {
  const fields: Array<{ via: string; deps: Record<string, string> }> = [
    { via: "dependencies", deps: pkg.dependencies },
    { via: "devDependencies", deps: pkg.devDependencies },
    { via: "peerDependencies", deps: pkg.peerDependencies },
  ];
  const edges: GraphEdge[] = [];
  for (const field of fields) {
    for (const [name, version] of Object.entries(field.deps)) {
      if (isGraphDependency(name, version)) {
        edges.push({ from: pkg.name, to: name, via: `${pkg.name} ${field.via}` });
      }
    }
  }
  return edges;
}

function resolveReferenceName(
  pkg: WorkspacePackage,
  refPath: string,
  packagesByDir: Map<string, WorkspacePackage>,
): string | undefined {
  const resolved = path.normalize(path.resolve(pkg.dir, refPath));
  const target = packagesByDir.get(resolved);
  return target?.name;
}

function findCycles(edges: readonly GraphEdge[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const list = graph.get(edge.from) ?? [];
    list.push(edge.to);
    graph.set(edge.from, list);
    if (!graph.has(edge.to)) {
      graph.set(edge.to, []);
    }
  }
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (visited.has(node)) {
      return;
    }
    if (visiting.has(node)) {
      const start = stack.lastIndexOf(node);
      if (start >= 0) {
        cycles.push([...stack.slice(start), node]);
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      dfs(next);
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }
  return cycles;
}

function issue(kind: GraphIssueKind, message: string): GraphIssue {
  return { kind, message };
}

export function inspectWorkspace(rootDir: string): GraphReport {
  const issues: GraphIssue[] = [];
  const packages = loadWorkspacePackages(rootDir);
  const packagesByDir = new Map(packages.map((pkg) => [path.normalize(pkg.dir), pkg]));
  const edges: GraphEdge[] = [];

  for (const pkg of packages) {
    const depFields: Array<[string, Record<string, string>]> = [
      ["dependencies", pkg.dependencies],
      ["devDependencies", pkg.devDependencies],
      ["peerDependencies", pkg.peerDependencies],
    ];
    for (const [field, deps] of depFields) {
      for (const name of Object.keys(deps)) {
        if (isBannedPackage(name)) {
          issues.push(
            issue("banned-package", `${pkg.name} ${field} includes banned package ${name}`),
          );
        }
        if (pkg.kind === "packages" && isDomainForbidden(name)) {
          issues.push(issue("domain-forbidden-dep", `${pkg.name} must not depend on ${name}`));
        }
      }
    }
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (isRangedVersion(version)) {
        issues.push(
          issue(
            "ranged-version",
            `${pkg.name} production dependency ${name} uses ranged version ${version}`,
          ),
        );
      }
    }
    edges.push(...collectManifestEdges(pkg));
    for (const ref of pkg.references) {
      const targetName = resolveReferenceName(pkg, ref, packagesByDir);
      if (targetName === undefined) {
        issues.push(
          issue("forbidden-edge", `${pkg.name} tsconfig references unresolved path ${ref}`),
        );
        continue;
      }
      edges.push({ from: pkg.name, to: targetName, via: `${pkg.name} tsconfig` });
    }
  }

  const rootManifestPath = path.join(rootDir, "package.json");
  if (existsSync(rootManifestPath)) {
    const rootManifest = parseJsonFile(rootManifestPath);
    if (isRecord(rootManifest)) {
      const rootDeps = stringRecord(rootManifest.dependencies);
      for (const [name, version] of Object.entries(rootDeps)) {
        if (isRangedVersion(version)) {
          issues.push(
            issue(
              "ranged-version",
              `root production dependency ${name} uses ranged version ${version}`,
            ),
          );
        }
        if (isBannedPackage(name)) {
          issues.push(issue("banned-package", `root dependencies includes banned package ${name}`));
        }
      }
      const rootDev = stringRecord(rootManifest.devDependencies);
      const rootPeer = stringRecord(rootManifest.peerDependencies);
      for (const [name] of [...Object.entries(rootDev), ...Object.entries(rootPeer)]) {
        if (isBannedPackage(name)) {
          issues.push(issue("banned-package", `root toolchain includes banned package ${name}`));
        }
      }
    }
  }

  const cargo = inspectCargoGraph(rootDir);
  issues.push(...cargo.issues);

  for (const edge of edges) {
    if (!edgeIsAllowed(edge.from, edge.to)) {
      issues.push(
        issue("forbidden-edge", `forbidden edge ${edge.from} -> ${edge.to} via ${edge.via}`),
      );
    }
  }
  edges.push(...cargo.edges);

  const piVersions = new Set<string>();
  for (const pkg of packages) {
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      for (const [name, version] of Object.entries(deps)) {
        if (name.startsWith("@earendil-works/pi-")) {
          piVersions.add(version.replace(/^workspace:/, ""));
        }
      }
    }
  }
  if (piVersions.size > 1) {
    issues.push(
      issue(
        "pi-version-mismatch",
        `@earendil-works/pi-* versions differ: ${[...piVersions].join(", ")}`,
      ),
    );
  }

  for (const cycle of findCycles(edges)) {
    issues.push(issue("cycle", `cycle: ${cycle.join(" -> ")}`));
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

function main(): void {
  const report = inspectWorkspace(process.cwd());
  for (const item of report.issues) {
    console.error(item.message);
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (isExecutedAsCli(import.meta.url)) {
  main();
}
