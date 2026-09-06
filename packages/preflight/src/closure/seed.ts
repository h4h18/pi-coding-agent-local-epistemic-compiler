import {
  sha256Utf8,
  type EvidenceGraph,
  type EvidenceId,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  artifactSourceRef,
  asObjectDigest,
  createEvidenceEdge,
  createEvidenceNode,
  defaultTrust,
  emptyEvidenceGraph,
  independenceGroupFor,
  makeProvenance,
  mergeEvidence,
} from "@pi-hec/evidence";
import type { PreflightRequirement } from "./evaluate.js";

export type SeedInstruction = {
  path: string;
  contentDigest: ReturnType<typeof sha256Utf8>;
};

export type SeedTask = {
  originalRequest: string;
  snapshotId: SnapshotId;
  requirements: readonly PreflightRequirement[];
};

export function deterministicSeed(
  task: SeedTask,
  instructions: readonly SeedInstruction[],
  nowIso: string,
): EvidenceGraph {
  const requestDigest = sha256Utf8(task.originalRequest);
  const extractorId = "pi-hec-preflight-seed/v1";
  const taskNode = createEvidenceNode({
    snapshotId: task.snapshotId,
    kind: "task",
    identityKey: `task:${requestDigest}`,
    authorship: "DETERMINISTIC",
    label: task.originalRequest.slice(0, 1024),
    contentObjectDigest: asObjectDigest(requestDigest),
    status: "verified",
    trust: defaultTrust({
      independenceGroup: independenceGroupFor(extractorId, requestDigest),
      authority: 1,
      directness: "asserted",
    }),
    provenance: [
      makeProvenance({
        source: artifactSourceRef({
          artifactObjectDigest: asObjectDigest(requestDigest),
          quoteDigest: requestDigest,
          sourceKind: "user-task",
        }),
        extractorId,
        extractorVersion: "seed/v1",
        observedAt: nowIso,
        contentDigest: requestDigest,
      }),
    ],
    estimatedTokens: Math.max(1, Math.ceil(task.originalRequest.length / 4)),
  });
  const requirementNodes = [...task.requirements]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((requirement) => {
      const digest = sha256Utf8(`requirement:${requirement.id}:${requirement.text}`);
      return createEvidenceNode({
        snapshotId: task.snapshotId,
        kind: "requirement",
        identityKey: `requirement:${requirement.id}`,
        authorship: "DETERMINISTIC",
        label: requirement.text.slice(0, 1024),
        contentObjectDigest: asObjectDigest(digest),
        status: "probable",
        trust: defaultTrust({
          independenceGroup: independenceGroupFor(extractorId, digest),
          authority: 1,
          directness: "asserted",
        }),
        provenance: [
          makeProvenance({
            source: artifactSourceRef({
              artifactObjectDigest: asObjectDigest(digest),
              quoteDigest: digest,
              sourceKind: "user-task",
            }),
            extractorId,
            extractorVersion: "seed/v1",
            observedAt: nowIso,
            contentDigest: digest,
          }),
        ],
        estimatedTokens: Math.max(1, Math.ceil(requirement.text.length / 4)),
      });
    });
  const instructionNodes = [...instructions]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((instruction) =>
      createEvidenceNode({
        snapshotId: task.snapshotId,
        kind: "instruction",
        identityKey: `instruction:${instruction.path}`,
        authorship: "DETERMINISTIC",
        label: instruction.path.slice(0, 1024),
        contentObjectDigest: asObjectDigest(instruction.contentDigest),
        status: "verified",
        trust: defaultTrust({
          independenceGroup: independenceGroupFor(extractorId, instruction.contentDigest),
          authority: 1,
          directness: "static-derived",
        }),
        provenance: [
          makeProvenance({
            source: {
              origin: "repository",
              sourceKind: "project-instruction",
              snapshotId: task.snapshotId,
              artifactObjectDigest: asObjectDigest(instruction.contentDigest),
              path: instruction.path,
              range: { kind: "whole" },
              quoteDigest: instruction.contentDigest,
            },
            extractorId,
            extractorVersion: "seed/v1",
            observedAt: nowIso,
            contentDigest: instruction.contentDigest,
          }),
        ],
        estimatedTokens: 1,
      }),
    );
  const nodes = [taskNode, ...requirementNodes, ...instructionNodes];
  const edges = [
    ...requirementNodes.map((node) =>
      createEvidenceEdge({
        from: taskNode.id,
        to: node.id,
        relation: "CONTAINS",
        polarity: "positive",
        confidence: 1,
        provenance: taskNode.provenance,
      }),
    ),
    ...instructionNodes.map((node) =>
      createEvidenceEdge({
        from: node.id,
        to: taskNode.id,
        relation: "APPLIES_TO",
        polarity: "positive",
        confidence: 1,
        provenance: node.provenance,
      }),
    ),
  ];
  return mergeEvidence(emptyEvidenceGraph(task.snapshotId), nodes, edges);
}

export type { EvidenceGraph, EvidenceId };
