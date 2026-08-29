import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type FixtureManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  references?: string[];
};

export type WorkspaceFixture = {
  packages?: Record<string, FixtureManifest>;
  apps?: Record<string, FixtureManifest>;
};

async function writePackage(
  rootDir: string,
  kind: "packages" | "apps",
  folder: string,
  manifest: FixtureManifest,
): Promise<void> {
  const dir = path.join(rootDir, kind, folder);
  await mkdir(dir, { recursive: true });
  const name = manifest.name ?? `@pi-hec/${folder}`;
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        peerDependencies: manifest.peerDependencies,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const references = (manifest.references ?? []).map((ref) => ({ path: ref }));
  await writeFile(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify({ references }, null, 2)}\n`,
    "utf8",
  );
}

export async function writeWorkspaceFixture(
  rootDir: string,
  fixture: WorkspaceFixture,
): Promise<void> {
  await writeFile(
    path.join(rootDir, "pnpm-workspace.yaml"),
    `packages:\n  - "apps/*"\n  - "packages/*"\n`,
    "utf8",
  );
  await writeFile(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "pi-hec", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  for (const [folder, manifest] of Object.entries(fixture.packages ?? {})) {
    await writePackage(rootDir, "packages", folder, manifest);
  }
  for (const [folder, manifest] of Object.entries(fixture.apps ?? {})) {
    await writePackage(rootDir, "apps", folder, manifest);
  }
}
