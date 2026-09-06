import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { rebuildSnapshotIndex } from "@pi-hec/repository";
import {
  collectDeltas,
  createRetrievalChannels,
  ingestLocalEvidenceProposal,
  openIndexDatabase,
  retrieveAndFuse,
} from "../src/claims.js";
import { isHistoricalNode } from "../src/graph.js";
import {
  PROJECT,
  RUN_ID,
  SNAPSHOT_ID,
  TS,
  claimId,
  cleanupTempDirs,
  dirEntry,
  fileEntry,
  gitHistory,
  memoryBlobs,
  snapshotOf,
  tempDir,
  utf8,
} from "./helpers.js";

afterEach(async () => {
  await cleanupTempDirs();
});

test("channels seed BM25 and dense lists and retrieveAndFuse uses RRF", async () => {
  const blobs = memoryBlobs();
  const entries = [
    dirEntry("src"),
    fileEntry(
      "src/math.ts",
      utf8("export function add(a: number, b: number) { return a + b; }\n"),
      blobs,
    ),
    fileEntry("README.md", utf8("# Docs\n\nThe fnordwidget API is documented here.\n"), blobs),
    fileEntry(
      "AGENTS.md",
      utf8("# Agents\n\nFollow project instructions for fnordwidget.\n"),
      blobs,
    ),
    fileEntry(
      "src/math.test.ts",
      utf8("import { add } from './math.ts';\ntest('add', () => add(1, 2));\n"),
      blobs,
    ),
    fileEntry("package.json", utf8('{"name":"demo","version":"1.0.0"}\n'), blobs),
  ];
  const manifest = snapshotOf(entries);
  const dir = await tempDir("pi-hec-evidence-");
  const dbPath = path.join(dir, "index.db");
  await rebuildSnapshotIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
    gitHistory: gitHistory(["src/math.ts"]),
  });
  const db = openIndexDatabase(dbPath);
  try {
    const host = { snapshotId: SNAPSHOT_ID, db, nowIso: () => TS };
    const claim = claimId("fnord");
    const result = await retrieveAndFuse(
      host,
      {
        runId: RUN_ID,
        snapshotId: SNAPSHOT_ID,
        claimIds: [claim],
        entityHints: ["fnordwidget"],
        relationHints: [],
      },
      new AbortController().signal,
    );
    expect(result.fusion.ranked.length).toBeGreaterThan(0);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.nodes.every((node) => node.provenance.length > 0)).toBe(true);
    expect(result.fusion.ranked.every((item) => item.features.rrfScore === item.rrfScore)).toBe(
      true,
    );
    const channels = createRetrievalChannels(host);
    const instructions = channels.find((channel) => channel.id === "instructions");
    if (instructions === undefined) {
      throw new Error("missing instructions channel");
    }
    const instructionDeltas = await collectDeltas(
      instructions.seed(
        {
          runId: RUN_ID,
          snapshotId: SNAPSHOT_ID,
          claimIds: [claim],
          entityHints: ["fnordwidget"],
          relationHints: [],
        },
        new AbortController().signal,
      ),
    );
    expect(
      instructionDeltas.some((delta) =>
        delta.nodes.some(
          (node) => node.kind === "instruction" || node.identityKey.includes("AGENTS"),
        ),
      ),
    ).toBe(true);
    const git = channels.find((channel) => channel.id === "git-history");
    if (git === undefined) {
      throw new Error("missing git channel");
    }
    const gitDeltas = await collectDeltas(
      git.seed(
        {
          runId: RUN_ID,
          snapshotId: SNAPSHOT_ID,
          claimIds: [claim],
          entityHints: ["math"],
          relationHints: [],
        },
        new AbortController().signal,
      ),
    );
    expect(gitDeltas.some((delta) => delta.nodes.some((node) => isHistoricalNode(node)))).toBe(
      true,
    );
  } finally {
    db.close();
  }
});

test("channel dropout records capability evidence and does not drop claims", async () => {
  const claim = claimId("missing-index");
  const host = { snapshotId: SNAPSHOT_ID, nowIso: () => TS };
  const result = await retrieveAndFuse(
    host,
    {
      runId: RUN_ID,
      snapshotId: SNAPSHOT_ID,
      claimIds: [claim],
      entityHints: ["anything"],
      relationHints: [],
    },
    new AbortController().signal,
  );
  expect(result.delta.unresolvedClaimIds).toContain(claim);
  expect(result.delta.nodes.some((node) => node.identityKey.includes("channel-capability"))).toBe(
    true,
  );
});

test("local evidence proposals stay LOCAL_MODEL and are never transmuted", () => {
  const node = ingestLocalEvidenceProposal(
    SNAPSHOT_ID,
    {
      proposalId: "proposal-1",
      kind: "hypothesis",
      statement: "the bug is in add",
      citedSourceRefs: [],
      targetClaimIds: [claimId("hyp")],
      requestedReproductionActions: [],
    },
    TS,
  );
  expect(node.authorship).toBe("LOCAL_MODEL");
  expect(node.kind).toBe("hypothesis");
  expect(node.trust.directness).toBe("model-derived");
});
