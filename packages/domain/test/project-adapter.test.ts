import { expect, test } from "vitest";
import type { SnapshotEntry } from "@pi-hec/contracts";
import {
  DEFAULT_PROJECT_ADAPTER,
  findProjectAdapterSnapshotEntry,
  lockProjectAdapter,
  lockProjectAdapterFromDocument,
  parseProjectAdapterDocument,
  validateProjectAdapter,
} from "../src/index.js";

test("missing adapter file locks to defaults without tightening", () => {
  const locked = lockProjectAdapter(undefined);
  expect(locked.tightened).toBe(false);
  expect(locked.adapter).toEqual(DEFAULT_PROJECT_ADAPTER);
  expect(locked.adapter.network.default).toBe("deny");
});

test("yaml adapter is parsed and merged without weakening network default", () => {
  const locked = lockProjectAdapterFromDocument(`
schemaVersion: 1
project:
  id: demo.app
  adapter: node
spec:
  roots:
    - specs
    - docs
  behaviorChangeRequiresUpdate: true
verification:
  baseline: []
  targeted: []
  final: []
protectedPaths:
  - ".env*"
  - secrets/**
network:
  default: deny
  externalResearch: deny
`);
  expect(locked.tightened).toBe(true);
  expect(locked.adapter.project.id).toBe("demo.app");
  expect(locked.adapter.spec.roots).toEqual(["specs", "docs"]);
  expect(locked.adapter.network.default).toBe("deny");
  expect(locked.adapter.protectedPaths).toEqual(expect.arrayContaining([".env*", "secrets/**"]));
});

test("json adapter is accepted from snapshot document", () => {
  const parsed = parseProjectAdapterDocument(JSON.stringify(DEFAULT_PROJECT_ADAPTER));
  expect(validateProjectAdapter(parsed)).toEqual(DEFAULT_PROJECT_ADAPTER);
});

test("adapter cannot weaken network.default", () => {
  expect(() =>
    lockProjectAdapterFromDocument(`
schemaVersion: 1
project:
  id: bad
  adapter: auto
spec:
  roots:
    - specs
  behaviorChangeRequiresUpdate: false
verification:
  baseline: []
  targeted: []
  final: []
protectedPaths: []
network:
  default: allow
  externalResearch: allow
`),
  ).toThrow(/network default/u);
});

test("snapshot lookup prefers yaml then json adapter paths", () => {
  const jsonOnly: SnapshotEntry[] = [
    {
      path: ".pi/hec-adapter.json",
      entryType: "file",
      contentDigest: "sha256:00",
      size: 2,
      gitMode: "100644",
      platformMetadata: {
        kind: "posix",
        device: "1",
        inode: "2",
        mode: 0o644,
        ownerId: 0,
        groupId: 0,
        xattrsDigest: "sha256:00",
      },
      storage: {
        kind: "blob",
        objectDigest: `sha256:${"ab".repeat(32)}`,
      },
    },
  ];
  expect(findProjectAdapterSnapshotEntry(jsonOnly)?.path).toBe(".pi/hec-adapter.json");
});
