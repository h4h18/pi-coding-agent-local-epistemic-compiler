import { Compile } from "typebox/compile";
import {
  RetrievalActionSchema,
  type EvidenceGraph,
  type RetrievalAction,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  RETRIEVAL_CHANNEL_IDS,
  actionCanonicalDigest,
  asEvidenceId,
  createRetrievalAction,
  normalizeQuery,
  type RetrievalChannelId,
} from "@pi-hec/evidence";
import { LOCAL_TEXT_TAINT_MARKER, persistAnalystTrace, scanAnalystText } from "./tools/scanner.js";

const ACTION = Compile(RetrievalActionSchema);

const FORBIDDEN_FILTERS = new Set(["command", "argv", "cwd", "patch", "content", "fileContent"]);

export const TOOL_CHANNEL_TO_RETRIEVAL: Readonly<Record<string, RetrievalChannelId>> = {
  lexical: "bm25",
  structural: "ast",
  history: "git-history",
  tests: "tests",
  instructions: "instructions",
};

const RETRIEVAL_SET: ReadonlySet<string> = new Set(RETRIEVAL_CHANNEL_IDS);

export const ANALYST_LANES = [
  "requirements",
  "structure",
  "runtime-tests",
  "history",
  "instructions",
  "risk",
  "counter-evidence",
] as const;

export type AnalystLane = (typeof ANALYST_LANES)[number];

export function resolveChannelId(channelId: string): RetrievalChannelId | undefined {
  if (RETRIEVAL_SET.has(channelId)) {
    return channelId as RetrievalChannelId;
  }
  return TOOL_CHANNEL_TO_RETRIEVAL[channelId];
}

export type ProposedActionClassification =
  | { kind: "admissible"; action: RetrievalAction }
  | { kind: "pending_targets" }
  | { kind: "inadmissible" };

export function classifyProposedAction(
  snapshotId: SnapshotId,
  graph: EvidenceGraph,
  proposed: RetrievalAction,
): ProposedActionClassification {
  persistAnalystTrace(proposed.query);
  if (!ACTION.Check(proposed)) {
    return { kind: "inadmissible" };
  }
  const channelId = resolveChannelId(proposed.channelId);
  if (channelId === undefined) {
    return { kind: "inadmissible" };
  }
  for (const key of Object.keys(proposed.filters)) {
    if (FORBIDDEN_FILTERS.has(key)) {
      return { kind: "inadmissible" };
    }
    if (key === "url" && channelId !== "external-docs") {
      return { kind: "inadmissible" };
    }
  }
  const known = new Set(graph.nodes.map((node) => node.id));
  const targets = proposed.targetClaimIds.filter((id) => known.has(id));
  if (targets.length === 0) {
    if (proposed.targetClaimIds.length > 0) {
      return { kind: "pending_targets" };
    }
    return { kind: "inadmissible" };
  }
  const scan = scanAnalystText(proposed.query);
  let query = normalizeQuery(proposed.query);
  if (scan.tainted || query === LOCAL_TEXT_TAINT_MARKER) {
    const fallback = graph.nodes.find((node) => node.id === targets[0]);
    if (fallback === undefined) {
      return { kind: "inadmissible" };
    }
    query = fallback.identityKey.slice(0, 4096);
  }
  if (query.length === 0) {
    return { kind: "inadmissible" };
  }
  const reconstructed = createRetrievalAction({
    id: proposed.id,
    channelId,
    targetClaimIds: targets.map((id) => asEvidenceId(id)),
    query,
    filters: proposed.filters,
    expectedInformationGain: proposed.expectedInformationGain,
    expectedTrustGain: proposed.expectedTrustGain,
    estimatedLatencyMs: proposed.estimatedLatencyMs,
    estimatedPacketTokens: proposed.estimatedPacketTokens,
  });
  if (!ACTION.Check(reconstructed)) {
    return { kind: "inadmissible" };
  }
  return {
    kind: "admissible",
    action: { ...reconstructed, id: actionCanonicalDigest(snapshotId, reconstructed) },
  };
}

export function reconstructAction(
  snapshotId: SnapshotId,
  graph: EvidenceGraph,
  proposed: RetrievalAction,
): RetrievalAction | undefined {
  const classified = classifyProposedAction(snapshotId, graph, proposed);
  return classified.kind === "admissible" ? classified.action : undefined;
}
