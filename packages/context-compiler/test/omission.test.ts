import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { canonicalizeRfc8785, objectDigestFromBytes, taggedHash } from "@pi-hec/contracts";
import { createFilesystemCas, MemoryStorageRecordSink, neverOccupied } from "@pi-hec/cas";
import {
  compareUtf8,
  createEvidenceNode,
  defaultTrust,
  independenceGroupFor,
} from "@pi-hec/evidence";
import { persistCompiledCloudArtifacts, selectBundles, compileCloudContext } from "../src/index.js";
import {
  PROJECT,
  SNAP,
  SOURCE_BODY,
  buildWorld,
  compilerInput,
  digestOf,
  nodeProvenance,
  payloadFor,
} from "./fixtures.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("a node present in a selected bundle is not marked omitted from a leftover bundle", () => {
  const world = buildWorld();
  const fileNode = world.graph.nodes.find((node) => node.kind === "file");
  expect(fileNode).toBeDefined();
  if (fileNode === undefined) {
    return;
  }
  const leftover = {
    id: "bundle-leftover",
    purpose: "runtime-observation" as const,
    nodeIds: [fileNode.id],
    edgeIds: [],
    exactSourceRefs: [],
    mandatory: false,
  };
  const selected = selectBundles({
    bundles: [...world.bundles, leftover],
    graph: world.graph,
    ledger: compilerInput().requirementLedger,
    tokenBudget: 10_000,
    estimateBundleTokens: () => 8,
  });
  expect(selected.kind).toBe("selected");
  if (selected.kind !== "selected") {
    return;
  }
  const selectedIds = new Set(selected.bundles.flatMap((bundle) => [...bundle.nodeIds]));
  expect(selectedIds.has(fileNode.id)).toBe(true);
  expect(selected.omitted.some((item) => item.evidenceId === fileNode.id)).toBe(false);
});

test("untrusted critical evidence is not a successful dispatch with empty criticalOmissions", () => {
  const world = buildWorld();
  const untrusted = createEvidenceNode({
    snapshotId: SNAP,
    kind: "risk",
    identityKey: "risk:untrusted-critical",
    authorship: "DETERMINISTIC",
    label: "untrusted-critical",
    status: "verified",
    contentObjectDigest: digestOf("untrusted-critical"),
    trust: defaultTrust({
      independenceGroup: independenceGroupFor("indexer", "untrusted-critical"),
      adversarialRisk: 0.92,
    }),
    provenance: nodeProvenance("risks.md", "critical counter-evidence"),
    estimatedTokens: 8,
  });
  const outcome = compileCloudContext(
    compilerInput({
      graph: { ...world.graph, nodes: [...world.graph.nodes, untrusted] },
      bundles: [
        ...world.bundles,
        {
          id: "bundle-counter",
          purpose: "counter-evidence",
          nodeIds: [untrusted.id],
          edgeIds: [],
          exactSourceRefs: [],
          mandatory: false,
        },
      ],
      payloads: [...world.payloads, payloadFor(untrusted, "risks.md", "critical counter-evidence")],
    }),
  );
  expect(outcome.kind).not.toBe("compiled");
  if (outcome.kind === "failed") {
    expect(outcome.code).toBe("CRITICAL_OMISSION");
  }
  if (outcome.kind === "compiled") {
    expect(outcome.artifacts.packet.omissionManifest.criticalOmissions.length).toBeGreaterThan(0);
  }
});

test("persist writes the omission-root artifact", async () => {
  const world = buildWorld();
  const extra = createEvidenceNode({
    snapshotId: SNAP,
    kind: "external-documentation",
    identityKey: "doc:optional-omitted",
    authorship: "DETERMINISTIC",
    label: "optional doc",
    status: "verified",
    contentObjectDigest: digestOf("optional-doc"),
    trust: defaultTrust({ independenceGroup: independenceGroupFor("docs", "optional-doc") }),
    provenance: nodeProvenance("docs/optional.md", "optional documentation"),
    estimatedTokens: 8,
  });
  const outcome = compileCloudContext(
    compilerInput({
      graph: { ...world.graph, nodes: [...world.graph.nodes, extra] },
      bundles: [
        ...world.bundles,
        {
          id: "bundle-optional-doc",
          purpose: "runtime-observation",
          nodeIds: [extra.id],
          edgeIds: [],
          exactSourceRefs: [],
          mandatory: false,
        },
      ],
      payloads: [
        ...world.payloads,
        payloadFor(extra, "docs/optional.md", "optional documentation"),
      ],
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const rootDir = await mkdtemp(path.join(tmpdir(), "pi-hec-omit-"));
  dirs.push(rootDir);
  const cas = createFilesystemCas({
    rootDir,
    sink: new MemoryStorageRecordSink(),
    kek: {
      unwrapProjectDek: () => ({
        keyId: "test-dek-1",
        dek: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      }),
    },
    occupancy: neverOccupied(),
  });
  await persistCompiledCloudArtifacts({ cas, projectId: PROJECT, artifacts: outcome.artifacts });
  const pairs = [...outcome.artifacts.omittedEvidence].sort((left, right) => {
    const byId = compareUtf8(left.evidenceId, right.evidenceId);
    if (byId !== 0) {
      return byId;
    }
    return compareUtf8(left.reason, right.reason);
  });
  const bytes = Buffer.from(canonicalizeRfc8785({ pairs }), "utf8");
  const loaded = await cas.getObject({
    projectId: PROJECT,
    objectDigest: objectDigestFromBytes(bytes),
  });
  expect(Buffer.from(loaded).equals(bytes)).toBe(true);
  expect(taggedHash("omission-root", 1, { pairs })).toBe(
    outcome.artifacts.packet.omissionManifest.omittedEvidenceRootDigest,
  );
  expect(SOURCE_BODY.length).toBeGreaterThan(0);
});
