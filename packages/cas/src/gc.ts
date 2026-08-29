import { constants, copyFile, link, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { ObjectDigestSchema } from "@pi-hec/contracts";
import type { ObjectDigest } from "@pi-hec/contracts";
import { Compile } from "typebox/compile";
import { CasError, INCOMING_SWEEP_MIN_MS, isNodeError, QUARANTINE_MIN_DAYS } from "./blob-store.js";
import type { CasClock, OccupancyPredicate } from "./blob-store.js";

const OBJECT_DIGEST = Compile(ObjectDigestSchema);

const HEX64 = /^[0-9a-f]{64}$/;
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CasLayout = {
  rootDir: string;
  projectRoot: (projectId: string) => string;
  incomingDir: (projectId: string) => string;
  sha256Root: (projectId: string) => string;
  objectPath: (projectId: string, hex: string) => string;
  quarantineRoot: (projectId: string) => string;
  quarantinePath: (projectId: string, date: string, hex: string) => string;
};

export function createCasLayout(rootDir: string): CasLayout {
  return {
    rootDir,
    projectRoot: (projectId) => path.join(rootDir, "projects", projectId),
    incomingDir: (projectId) => path.join(rootDir, "projects", projectId, "incoming"),
    sha256Root: (projectId) => path.join(rootDir, "projects", projectId, "sha256"),
    objectPath: (projectId, hex) =>
      path.join(rootDir, "projects", projectId, "sha256", hex.slice(0, 2), hex.slice(2, 4), hex),
    quarantineRoot: (projectId) => path.join(rootDir, "projects", projectId, "quarantine"),
    quarantinePath: (projectId, date, hex) =>
      path.join(rootDir, "projects", projectId, "quarantine", date, hex),
  };
}

export function digestToHex(digest: ObjectDigest): string {
  return digest.slice("sha256:".length);
}

export function isSha256Hex(value: string): boolean {
  return HEX64.test(value);
}

export async function moveToQuarantine(
  layout: CasLayout,
  projectId: string,
  hex: string,
  date: string,
): Promise<void> {
  const source = layout.objectPath(projectId, hex);
  const dest = layout.quarantinePath(projectId, date, hex);
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await link(source, dest);
    await unlink(source);
    return;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    if (isNodeError(error) && error.code === "EEXIST") {
      await unlink(source);
      return;
    }
  }
  try {
    await copyFile(source, dest, constants.COPYFILE_EXCL);
    await unlink(source);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    if (isNodeError(error) && error.code === "EEXIST") {
      await unlink(source);
      return;
    }
    throw error;
  }
}

export async function listStoredHex(layout: CasLayout, projectId: string): Promise<string[]> {
  const root = layout.sha256Root(projectId);
  const found: string[] = [];
  let aaEntries;
  try {
    aaEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return found;
    }
    throw error;
  }
  for (const aa of aaEntries) {
    if (!aa.isDirectory() || aa.name.length !== 2) {
      continue;
    }
    const bbEntries = await readdir(path.join(root, aa.name), { withFileTypes: true });
    for (const bb of bbEntries) {
      if (!bb.isDirectory() || bb.name.length !== 2) {
        continue;
      }
      const files = await readdir(path.join(root, aa.name, bb.name), { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && isSha256Hex(file.name) && file.name.startsWith(aa.name + bb.name)) {
          found.push(file.name);
        }
      }
    }
  }
  return found;
}

export async function markUnreachableObjects(input: {
  layout: CasLayout;
  projectId: string;
  reachable: ReadonlySet<ObjectDigest>;
  occupancy: OccupancyPredicate;
  clock: CasClock;
}): Promise<void> {
  const date = input.clock.nowIso().slice(0, 10);
  const stored = await listStoredHex(input.layout, input.projectId);
  for (const hex of stored) {
    const digest = hexToObjectDigest(hex);
    if (input.reachable.has(digest)) {
      continue;
    }
    if (await input.occupancy.isGcForbidden(input.projectId, digest)) {
      continue;
    }
    await moveToQuarantine(input.layout, input.projectId, hex, date);
  }
}

export async function sweepQuarantineObjects(input: {
  layout: CasLayout;
  projectId: string;
  occupancy: OccupancyPredicate;
  clock: CasClock;
  skipIncoming?: boolean;
  protectedIncoming?: ReadonlySet<string>;
}): Promise<void> {
  const root = input.layout.quarantineRoot(input.projectId);
  let dateDirs: Dirent[];
  try {
    dateDirs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      dateDirs = [];
    } else {
      throw error;
    }
  }
  const now = input.clock.nowMs();
  for (const dateDir of dateDirs) {
    if (!dateDir.isDirectory() || !DATE_FOLDER.test(dateDir.name)) {
      continue;
    }
    const started = Date.parse(`${dateDir.name}T00:00:00.000Z`);
    if (!Number.isFinite(started)) {
      continue;
    }
    const ageMs = now - started;
    if (ageMs < QUARANTINE_MIN_DAYS * MS_PER_DAY) {
      continue;
    }
    const folder = path.join(root, dateDir.name);
    const files = await readdir(folder, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !isSha256Hex(file.name)) {
        continue;
      }
      const digest = hexToObjectDigest(file.name);
      if (await input.occupancy.isGcForbidden(input.projectId, digest)) {
        continue;
      }
      await unlink(path.join(folder, file.name));
    }
  }
  if (input.skipIncoming !== true) {
    await sweepIncoming({
      layout: input.layout,
      projectId: input.projectId,
      clock: input.clock,
      protectedIncoming: input.protectedIncoming ?? new Set(),
    });
  }
}

async function sweepIncoming(input: {
  layout: CasLayout;
  projectId: string;
  clock: CasClock;
  protectedIncoming: ReadonlySet<string>;
}): Promise<void> {
  const dir = input.layout.incomingDir(input.projectId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const now = input.clock.nowMs();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (input.protectedIncoming.has(full)) {
      continue;
    }
    let info;
    try {
      info = await lstat(full);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      continue;
    }
    if (now - info.mtimeMs < INCOMING_SWEEP_MIN_MS) {
      continue;
    }
    await unlink(full);
  }
}

function hexToObjectDigest(hex: string): ObjectDigest {
  const digest = `sha256:${hex}`;
  if (!OBJECT_DIGEST.Check(digest)) {
    throw new CasError("INVALID_DIGEST", "quarantine object name is not a SHA-256 digest");
  }
  return digest as ObjectDigest;
}
