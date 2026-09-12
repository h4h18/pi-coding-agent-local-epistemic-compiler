import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createFilesystemCas, MemoryStorageRecordSink, neverOccupied } from "@pi-hec/cas";
import { seedGraph } from "@pi-hec/preflight";
import { handlePreflight } from "../src/preflight-handler.js";
import {
  INSTRUCTIONS,
  TASK,
  TS,
  silentAdapter,
} from "../../../packages/preflight/test/preflight-helpers.js";

const dirs: string[] = [];
const DEK = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("preflight handler persists evidence graph and closure report", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "pi-hec-cw-preflight-"));
  dirs.push(rootDir);
  const cas = createFilesystemCas({
    rootDir,
    sink: new MemoryStorageRecordSink(),
    kek: { unwrapProjectDek: () => ({ keyId: "test-dek-1", dek: DEK }) },
    occupancy: neverOccupied(),
    clock: { nowIso: () => TS, nowMs: () => Date.parse(TS) },
  });
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  expect(seeded.nodes.length).toBeGreaterThan(0);
  const result = await handlePreflight({
    projectId: "proj-preflight",
    cas,
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
  });
  expect(result.closure.state).toBe("SATURATED_WITH_UNKNOWNS");
  expect(result.evidenceGraphObjectDigest.startsWith("sha256:")).toBe(true);
  expect(result.closureReportObjectDigest.startsWith("sha256:")).toBe(true);
  const graphBytes = await cas.getObject({
    projectId: "proj-preflight",
    objectDigest: result.evidenceGraphObjectDigest,
  });
  const closureBytes = await cas.getObject({
    projectId: "proj-preflight",
    objectDigest: result.closureReportObjectDigest,
  });
  expect(JSON.parse(Buffer.from(graphBytes).toString("utf8"))).toMatchObject({
    snapshotId: TASK.snapshotId,
  });
  expect(JSON.parse(Buffer.from(closureBytes).toString("utf8"))).toMatchObject({
    state: "SATURATED_WITH_UNKNOWNS",
  });
});
