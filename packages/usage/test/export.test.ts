import { expect, test } from "vitest";
import type { ObjectDigest } from "@pi-hec/contracts";
import {
  CLASSIFICATION_DENIAL,
  buildExportManifest,
  filterExportableArtifacts,
  isClassificationPermitted,
} from "../src/export.js";

const INTERNAL = `sha256:${"11".repeat(32)}` as ObjectDigest;
const RESTRICTED = `sha256:${"22".repeat(32)}` as ObjectDigest;
const PUBLIC = `sha256:${"33".repeat(32)}` as ObjectDigest;

test("export drops artifacts above the permitted classification and never uses 403", () => {
  const artifacts = [
    {
      role: "task-envelope",
      objectDigest: PUBLIC,
      mediaType: "application/json",
      byteSize: 8,
      classification: "public" as const,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
    {
      role: "context-packet",
      objectDigest: INTERNAL,
      mediaType: "application/json",
      byteSize: 8,
      classification: "internal" as const,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
    {
      role: "transport-evidence",
      objectDigest: RESTRICTED,
      mediaType: "application/octet-stream",
      byteSize: 8,
      classification: "restricted" as const,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ];

  expect(isClassificationPermitted("restricted", "internal")).toBe(false);
  const selected = filterExportableArtifacts(artifacts, "internal");
  expect(selected.map((row) => row.objectDigest)).toEqual([PUBLIC, INTERNAL]);
  expect(selected.some((row) => row.classification === "restricted")).toBe(false);

  const manifest = buildExportManifest({
    projectId: "proj-export",
    permittedClassification: "internal",
    artifacts,
  });
  expect(manifest.artifactObjectDigests).toEqual([PUBLIC, INTERNAL]);
  expect(manifest.artifactObjectDigests).not.toContain(RESTRICTED);
  expect("httpStatus" in manifest).toBe(false);
  expect("deniedAs" in manifest).toBe(false);
  expect(CLASSIFICATION_DENIAL.httpStatus).toBe(404);
  expect(CLASSIFICATION_DENIAL.deniedAs).toBe("not-found");
});
