import { Compile } from "typebox/compile";
import {
  RetrievalActionSchema,
  canonicalizeRfc8785,
  sha256Utf8,
  type Digest,
  type EvidenceId,
  type ObjectDigest,
  type RetrievalAction,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  artifactSourceRef,
  createEvidenceNode,
  defaultTrust,
  independenceGroupFor,
  makeProvenance,
  type EvidenceDelta,
} from "./graph.js";

export type ExpandableChannel = {
  expand: (action: RetrievalAction, signal: AbortSignal) => AsyncIterable<EvidenceDelta>;
};

const ACTION = Compile(RetrievalActionSchema);

export function normalizeQuery(query: string): string {
  return query.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function canonicalizeFilters(filters: RetrievalAction["filters"]): string {
  return canonicalizeRfc8785(filters);
}

export function actionCanonicalDigest(
  snapshotId: SnapshotId,
  action: Pick<RetrievalAction, "channelId" | "query" | "filters">,
): Digest {
  const payload = `${snapshotId}${action.channelId}${normalizeQuery(action.query)}${canonicalizeFilters(action.filters)}`;
  return sha256Utf8(payload);
}

export type FrontierDecision = "accepted" | "repeat";

export class RetrievalFrontier {
  private readonly visited: Set<string>;

  constructor(
    readonly snapshotId: SnapshotId,
    visited: readonly Digest[] = [],
  ) {
    this.visited = new Set(visited);
  }

  visitedDigests(): Digest[] {
    return [...this.visited].sort() as Digest[];
  }

  canonicalDigest(action: Pick<RetrievalAction, "channelId" | "query" | "filters">): Digest {
    return actionCanonicalDigest(this.snapshotId, action);
  }

  has(action: Pick<RetrievalAction, "channelId" | "query" | "filters">): boolean {
    return this.visited.has(this.canonicalDigest(action));
  }

  register(action: Pick<RetrievalAction, "channelId" | "query" | "filters">): FrontierDecision {
    const digest = this.canonicalDigest(action);
    if (this.visited.has(digest)) {
      return "repeat";
    }
    this.visited.add(digest);
    return "accepted";
  }

  async *expand(
    channel: ExpandableChannel,
    action: RetrievalAction,
    baseDigest: ObjectDigest,
    unresolvedClaimIds: readonly EvidenceId[],
    observedAt: string,
    signal: AbortSignal,
  ): AsyncIterable<EvidenceDelta> {
    if (!ACTION.Check(action)) {
      throw new Error("retrieval action failed schema validation");
    }
    if (this.register(action) === "repeat") {
      yield repeatConflictDelta(
        this.snapshotId,
        action,
        baseDigest,
        unresolvedClaimIds,
        this.canonicalDigest(action),
        observedAt,
      );
      return;
    }
    yield* channel.expand(action, signal);
  }
}

function repeatConflictDelta(
  snapshotId: SnapshotId,
  action: RetrievalAction,
  baseDigest: ObjectDigest,
  unresolvedClaimIds: readonly EvidenceId[],
  digest: Digest,
  observedAt: string,
): EvidenceDelta {
  const provenance = [
    makeProvenance({
      source: artifactSourceRef({
        artifactObjectDigest: baseDigest,
        quoteDigest: digest,
        sourceKind: "runtime",
      }),
      extractorId: "pi-hec-retrieval-frontier/v1",
      extractorVersion: "no-repeat/v1",
      observedAt,
      contentDigest: digest,
    }),
  ];
  const node = createEvidenceNode({
    snapshotId,
    kind: "conflict",
    identityKey: `repeat-action:${digest}`.slice(0, 1024),
    authorship: "DETERMINISTIC",
    label: `repeat retrieval action ${action.channelId}`,
    status: "conflicted",
    trust: defaultTrust({
      independenceGroup: independenceGroupFor("pi-hec-retrieval-frontier/v1", digest),
      authority: 1,
      directness: "observed",
      adversarialRisk: 0,
    }),
    provenance,
    estimatedTokens: 1,
  });
  return {
    schemaVersion: 1,
    baseEvidenceGraphObjectDigest: baseDigest,
    nodes: [node],
    edges: [],
    unresolvedClaimIds: [...unresolvedClaimIds],
    nextActions: [],
  };
}

export function createRetrievalAction(input: {
  id: string;
  channelId: string;
  targetClaimIds: readonly EvidenceId[];
  query: string;
  filters?: RetrievalAction["filters"];
  expectedInformationGain?: number;
  expectedTrustGain?: number;
  estimatedLatencyMs?: number;
  estimatedPacketTokens?: number;
}): RetrievalAction {
  return {
    id: input.id,
    channelId: input.channelId,
    targetClaimIds: [...input.targetClaimIds],
    query: input.query,
    filters: input.filters ?? {},
    expectedInformationGain: input.expectedInformationGain ?? 0.5,
    expectedTrustGain: input.expectedTrustGain ?? 0.5,
    estimatedLatencyMs: input.estimatedLatencyMs ?? 1,
    estimatedPacketTokens: input.estimatedPacketTokens ?? 1,
  };
}
