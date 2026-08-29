import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type CargoGraphIssue = {
  kind: "forbidden-edge";
  message: string;
};

export type CargoGraphEdge = {
  from: string;
  to: string;
  via: string;
};

export type CargoGraphReport = {
  issues: CargoGraphIssue[];
  edges: CargoGraphEdge[];
};

export const CARGO_WORKSPACE_MEMBERS: Readonly<Record<string, string>> = {
  "pi-hec-runner": "native/runner",
};

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function posixMember(member: string): string {
  return member.replaceAll("\\", "/");
}

function parseQuotedStrings(text: string): string[] {
  const values: string[] = [];
  const pattern = /"([^"]+)"/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const value = match[1];
    if (value !== undefined) {
      values.push(value);
    }
    match = pattern.exec(text);
  }
  return values;
}

function parseCargoToml(text: string): {
  packageName: string | undefined;
  members: string[];
  pathDependencies: { name: string; depPath: string }[];
} {
  let packageName: string | undefined;
  let members: string[] = [];
  const pathDependencies: { name: string; depPath: string }[] = [];
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) {
      continue;
    }
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) {
      continue;
    }
    const arrayTableMatch = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (arrayTableMatch?.[1] !== undefined) {
      section = arrayTableMatch[1];
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch?.[1] !== undefined) {
      section = sectionMatch[1];
      continue;
    }
    if (section === "package") {
      const nameMatch = /^name\s*=\s*"([^"]+)"$/.exec(line);
      if (nameMatch?.[1] !== undefined) {
        packageName = nameMatch[1];
      }
    }
    if (section === "workspace" && line.startsWith("members")) {
      let blob = line;
      if (!line.includes("]")) {
        const collected = [line];
        let cursor = index + 1;
        while (cursor < lines.length) {
          const next = lines[cursor];
          if (next === undefined) {
            break;
          }
          collected.push(next);
          if (next.includes("]")) {
            break;
          }
          cursor += 1;
        }
        blob = collected.join("\n");
      }
      members = parseQuotedStrings(blob);
    }
    const inlinePath = /^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/.exec(line);
    if (
      (section === "dependencies" ||
        section === "dev-dependencies" ||
        section === "build-dependencies") &&
      inlinePath?.[1] !== undefined &&
      inlinePath[2] !== undefined
    ) {
      pathDependencies.push({ name: inlinePath[1], depPath: inlinePath[2] });
    }
    if (section.startsWith("dependencies.") && /^path\s*=\s*"([^"]+)"$/.exec(line)) {
      const depName = section.slice("dependencies.".length);
      const pathMatch = /^path\s*=\s*"([^"]+)"$/.exec(line);
      const depPath = pathMatch?.[1];
      if (depPath !== undefined) {
        pathDependencies.push({ name: depName, depPath });
      }
    }
  }
  return { packageName, members, pathDependencies };
}

export function cargoPathEdgeIsAllowed(from: string, to: string): boolean {
  return Object.hasOwn(CARGO_WORKSPACE_MEMBERS, from) && Object.hasOwn(CARGO_WORKSPACE_MEMBERS, to);
}

export function inspectCargoGraph(rootDir: string): CargoGraphReport {
  const cargoPath = path.join(rootDir, "Cargo.toml");
  if (!existsSync(cargoPath)) {
    return { issues: [], edges: [] };
  }
  const issues: CargoGraphIssue[] = [];
  const edges: CargoGraphEdge[] = [];
  const rootManifest = parseCargoToml(readText(cargoPath));
  const allowedMemberPaths = new Set(Object.values(CARGO_WORKSPACE_MEMBERS));

  for (const member of rootManifest.members) {
    const normalized = posixMember(member);
    if (!allowedMemberPaths.has(normalized)) {
      issues.push({
        kind: "forbidden-edge",
        message: `forbidden Cargo workspace member ${member}; only native/runner crate pi-hec-runner is allowed`,
      });
    }
    const memberCargo = path.join(rootDir, member, "Cargo.toml");
    if (!existsSync(memberCargo)) {
      continue;
    }
    const manifest = parseCargoToml(readText(memberCargo));
    const from = manifest.packageName ?? member;
    const expectedPath = CARGO_WORKSPACE_MEMBERS[from];
    if (expectedPath === undefined) {
      issues.push({
        kind: "forbidden-edge",
        message: `forbidden Cargo crate ${from} at ${member}; only pi-hec-runner is allowed`,
      });
    } else if (expectedPath !== normalized) {
      issues.push({
        kind: "forbidden-edge",
        message: `forbidden Cargo crate ${from} path ${member}; expected ${expectedPath}`,
      });
    }
    for (const dep of manifest.pathDependencies) {
      const via = `${member} Cargo.toml path`;
      edges.push({ from, to: dep.name, via });
      if (!cargoPathEdgeIsAllowed(from, dep.name)) {
        issues.push({
          kind: "forbidden-edge",
          message: `forbidden edge ${from} -> ${dep.name} via ${via}`,
        });
      }
    }
  }

  return { issues, edges };
}
