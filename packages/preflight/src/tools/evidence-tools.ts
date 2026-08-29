import { readFile } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  EvidenceExpandSymbolParametersSchema,
  EvidenceGetGitHistoryParametersSchema,
  EvidenceGetInstructionScopeParametersSchema,
  EvidenceGetRelationsParametersSchema,
  EvidenceGetTestObservationsParametersSchema,
  EvidenceReadSourceParametersSchema,
  EvidenceSearchParametersSchema,
  EvidenceSubmitActionsParametersSchema,
  EvidenceSubmitAuditParametersSchema,
  evidenceToolNames,
  objectDigestFromBytes,
  sha256Utf8,
  type Digest,
  type EvidenceGraph,
  type EvidenceId,
  type RetrievalAction,
  type SnapshotId,
  type SourceRange,
  type SourceRef,
} from "@pi-hec/contracts";
import {
  createRetrievalAction,
  createRetrievalChannels,
  retrieveAndFuse,
  type EvidenceChannelHost,
  type RetrievalIntent,
  type RetrieveAndFuseResult,
} from "@pi-hec/evidence";
import { persistAnalystTrace } from "./scanner.js";
import { EVIDENCE_TOOL_RESULT, emptyToolResult, type EvidenceToolResult } from "./results.js";
import { assertNoForbiddenParamNames, assertSnapshotPrefix, assertSnapshotRelativePath } from "./snapshot-path.js";

const SEARCH = Compile(EvidenceSearchParametersSchema);
const READ = Compile(EvidenceReadSourceParametersSchema);
const EXPAND = Compile(EvidenceExpandSymbolParametersSchema);
const RELATIONS = Compile(EvidenceGetRelationsParametersSchema);
const TESTS = Compile(EvidenceGetTestObservationsParametersSchema);
const GIT = Compile(EvidenceGetGitHistoryParametersSchema);
const SCOPE = Compile(EvidenceGetInstructionScopeParametersSchema);
const SUBMIT_ACTIONS = Compile(EvidenceSubmitActionsParametersSchema);
const SUBMIT_AUDIT = Compile(EvidenceSubmitAuditParametersSchema);

export type EvidenceProposalSink = {
  persistActions: (actions: readonly RetrievalAction[]) => void;
  persistAudit: (audit: {
    unknowns: readonly unknown[];
    conflicts: readonly unknown[];
    saturationReasons: readonly string[];
  }) => void;
};

export type EvidenceToolDependencies = {
  snapshotRoot: string;
  snapshotId: SnapshotId;
  snapshotPaths: ReadonlySet<string>;
  channelHost: EvidenceChannelHost;
  resolveInstructionScope: (relativePath: string) => readonly {
    path: string;
    contentDigest: Digest;
    evidenceIds?: readonly EvidenceId[];
  }[];
  getGitHistory: (relativePath: string, maxCommits: number) => Promise<EvidenceToolResult>;
  getTestObservations: (checkId: string) => Promise<EvidenceToolResult>;
  proposalSink: EvidenceProposalSink;
  graph?: EvidenceGraph;
  retrieveEvidence?: (
    host: EvidenceChannelHost,
    intent: RetrievalIntent,
    signal: AbortSignal,
  ) => Promise<RetrieveAndFuseResult>;
  expandSymbolEvidence?: (
    params: Static<typeof EvidenceExpandSymbolParametersSchema>,
    signal: AbortSignal,
  ) => Promise<EvidenceToolResult>;
};

function toolText(summary: string): { type: "text"; text: string }[] {
  persistAnalystTrace(summary);
  return [{ type: "text", text: summary }];
}

function checkedResult(result: EvidenceToolResult): EvidenceToolResult {
  if (!EVIDENCE_TOOL_RESULT.Check(result)) {
    throw new Error("evidence tool result failed schema validation");
  }
  return result;
}

function abortSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

function assertBoundSnapshotId(deps: EvidenceToolDependencies, snapshotId: SnapshotId): void {
  if (snapshotId !== deps.snapshotId) {
    throw new Error(`snapshotId does not match the bound snapshot: ${snapshotId}`);
  }
}

function snapshotSourceRef(input: {
  snapshotId: SnapshotId;
  path: string;
  digest: Digest;
  range: SourceRange;
}): SourceRef {
  return {
    origin: "repository",
    sourceKind: "repository",
    snapshotId: input.snapshotId,
    artifactObjectDigest: input.digest,
    path: input.path,
    range: input.range,
    quoteDigest: input.digest,
  };
}

async function digestSnapshotRange(
  snapshotRoot: string,
  relativePath: string,
  range: SourceRange,
): Promise<Digest> {
  const bytes = await readFile(path.join(snapshotRoot, ...relativePath.split("/")));
  if (range.kind === "whole") {
    return objectDigestFromBytes(bytes);
  }
  return objectDigestFromBytes(bytes.subarray(range.byteStart, range.byteEnd));
}

function searchIntent(deps: EvidenceToolDependencies, params: Static<typeof EvidenceSearchParametersSchema>): RetrievalIntent {
  const runId = deps.channelHost.runId;
  if (runId === undefined) {
    throw new Error("evidence_search requires channelHost.runId");
  }
  return {
    runId,
    snapshotId: params.snapshotId,
    claimIds: params.targetClaimIds,
    entityHints: params.query.split(/\s+/u).filter((hint) => hint.length > 0).slice(0, 8),
    relationHints: [],
  };
}

async function defaultExpandSymbol(
  deps: EvidenceToolDependencies,
  params: Static<typeof EvidenceExpandSymbolParametersSchema>,
  signal: AbortSignal,
): Promise<EvidenceToolResult> {
  const ids: EvidenceId[] = [];
  const channels = createRetrievalChannels(deps.channelHost);
  for (const channel of channels) {
    await channel.probe(deps.snapshotId);
  }
  const expanding = channels.find((channel) => channel.id === "scip") ?? channels.find((channel) => channel.id === "ast");
  if (expanding !== undefined) {
    const action = createRetrievalAction({
      id: "expand-symbol",
      channelId: expanding.id,
      targetClaimIds: [],
      query: params.symbolName,
      filters: { path: params.path, symbol: params.symbolName, relation: params.relation },
    });
    for await (const delta of expanding.expand(action, signal)) {
      for (const node of delta.nodes) {
        ids.push(node.id);
      }
    }
  }
  const graph = deps.graph ?? deps.channelHost.graph;
  if (graph !== undefined) {
    for (const node of graph.nodes) {
      if (node.identityKey.includes(params.symbolName) || node.label.includes(params.symbolName)) {
        ids.push(node.id);
      }
    }
  }
  const unique = [...new Set(ids)];
  const digest = sha256Utf8(`expand:${params.path}:${params.symbolName}:${params.relation}`);
  return {
    evidenceIds: unique,
    sourceRefs: [],
    quoteDigest: digest,
    contentDigest: digest,
  };
}

export function createEvidenceTools(deps: EvidenceToolDependencies): ToolDefinition[] {
  const search = defineTool({
    name: "evidence_search",
    label: "Evidence search",
    description: "Search snapshot-bound evidence channels. Returns content refs only.",
    parameters: EvidenceSearchParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      assertNoForbiddenParamNames(params);
      if (!SEARCH.Check(params)) {
        throw new Error("evidence_search parameters failed schema validation");
      }
      if (params.pathPrefix !== undefined) {
        assertSnapshotPrefix(deps.snapshotPaths, params.pathPrefix);
      }
      const retrieve = deps.retrieveEvidence ?? retrieveAndFuse;
      const fused = await retrieve(deps.channelHost, searchIntent(deps, params), abortSignal(signal));
      const digest = sha256Utf8(`search:${params.query}:${params.channelId}`);
      return {
        content: toolText("search hits are content refs only"),
        details: checkedResult({
          evidenceIds: fused.delta.nodes.map((node) => node.id),
          sourceRefs: [],
          quoteDigest: digest,
          contentDigest: digest,
        }),
      };
    },
  });
  const readSource = defineTool({
    name: "evidence_read_source",
    label: "Evidence read source",
    description: "Read a snapshot-relative source range as digests and refs.",
    parameters: EvidenceReadSourceParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!READ.Check(params)) {
        throw new Error("evidence_read_source parameters failed schema validation");
      }
      assertBoundSnapshotId(deps, params.snapshotId);
      const relative = assertSnapshotRelativePath(deps.snapshotPaths, params.path);
      const digest = await digestSnapshotRange(deps.snapshotRoot, relative, params.range);
      return {
        content: toolText("source bytes are not returned"),
        details: checkedResult({
          evidenceIds: [],
          sourceRefs: [
            snapshotSourceRef({
              snapshotId: deps.snapshotId,
              path: relative,
              digest,
              range: params.range,
            }),
          ],
          quoteDigest: digest,
          contentDigest: digest,
        }),
      };
    },
  });
  const expand = defineTool({
    name: "evidence_expand_symbol",
    label: "Evidence expand symbol",
    description: "Expand a snapshot-relative symbol relation to content refs.",
    parameters: EvidenceExpandSymbolParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      assertNoForbiddenParamNames(params);
      if (!EXPAND.Check(params)) {
        throw new Error("evidence_expand_symbol parameters failed schema validation");
      }
      assertSnapshotRelativePath(deps.snapshotPaths, params.path);
      const details = await (deps.expandSymbolEvidence ?? defaultExpandSymbol.bind(undefined, deps))(
        params,
        abortSignal(signal),
      );
      return {
        content: toolText("symbol expansion is content refs only"),
        details: checkedResult(details),
      };
    },
  });
  const relations = defineTool({
    name: "evidence_get_relations",
    label: "Evidence relations",
    description: "Read typed relations for an evidence id without mutating the graph.",
    parameters: EvidenceGetRelationsParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!RELATIONS.Check(params)) {
        throw new Error("evidence_get_relations parameters failed schema validation");
      }
      const graph = deps.graph ?? deps.channelHost.graph;
      const related = graph?.edges.filter(
        (edge) =>
          (edge.from === params.evidenceId || edge.to === params.evidenceId) &&
          params.edgeKinds.includes(edge.relation),
      );
      const ids = [...new Set((related ?? []).flatMap((edge) => [edge.from, edge.to]))] as EvidenceId[];
      const digest = sha256Utf8(`relations:${params.evidenceId}`);
      return {
        content: toolText("relations are typed refs only"),
        details: checkedResult({
          evidenceIds: ids,
          sourceRefs: [],
          quoteDigest: digest,
          contentDigest: digest,
        }),
      };
    },
  });
  const tests = defineTool({
    name: "evidence_get_test_observations",
    label: "Evidence test observations",
    description: "Read test observations for a check id as content refs.",
    parameters: EvidenceGetTestObservationsParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!TESTS.Check(params)) {
        throw new Error("evidence_get_test_observations parameters failed schema validation");
      }
      const details = checkedResult(await deps.getTestObservations(params.checkId));
      return { content: toolText("test observations are content refs only"), details };
    },
  });
  const git = defineTool({
    name: "evidence_get_git_history",
    label: "Evidence git history",
    description: "Read snapshot-bound git history refs for a path.",
    parameters: EvidenceGetGitHistoryParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!GIT.Check(params)) {
        throw new Error("evidence_get_git_history parameters failed schema validation");
      }
      const relative = assertSnapshotRelativePath(deps.snapshotPaths, params.path);
      const details = checkedResult(await deps.getGitHistory(relative, params.maxCommits));
      return { content: toolText("git history is content refs only"), details };
    },
  });
  const scope = defineTool({
    name: "evidence_get_instruction_scope",
    label: "Evidence instruction scope",
    description: "Resolve instruction scope for a snapshot-relative path.",
    parameters: EvidenceGetInstructionScopeParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!SCOPE.Check(params)) {
        throw new Error("evidence_get_instruction_scope parameters failed schema validation");
      }
      const relative = assertSnapshotRelativePath(deps.snapshotPaths, params.path);
      const resolved = deps.resolveInstructionScope(relative);
      const digest = sha256Utf8(`scope:${relative}`);
      return {
        content: toolText("instruction scope is content refs only"),
        details: checkedResult({
          evidenceIds: resolved.flatMap((item) => item.evidenceIds ?? []),
          sourceRefs: [],
          quoteDigest: digest,
          contentDigest: digest,
        }),
      };
    },
  });
  const submitActions = defineTool({
    name: "evidence_submit_actions",
    label: "Evidence submit actions",
    description: "Persist retrieval action proposals. Does not create authoritative graph nodes.",
    parameters: EvidenceSubmitActionsParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!SUBMIT_ACTIONS.Check(params)) {
        throw new Error("evidence_submit_actions parameters failed schema validation");
      }
      deps.proposalSink.persistActions(params.actions);
      const digest = sha256Utf8(`submit-actions:${params.actions.map((action) => action.id).join(",")}`);
      return {
        content: toolText("action proposals persisted as untrusted analyst trace"),
        details: checkedResult(emptyToolResult(digest)),
      };
    },
  });
  const submitAudit = defineTool({
    name: "evidence_submit_audit",
    label: "Evidence submit audit",
    description: "Persist audit proposals. Does not create authoritative graph nodes.",
    parameters: EvidenceSubmitAuditParametersSchema,
    execute: async (_toolCallId, params) => {
      assertNoForbiddenParamNames(params);
      if (!SUBMIT_AUDIT.Check(params)) {
        throw new Error("evidence_submit_audit parameters failed schema validation");
      }
      deps.proposalSink.persistAudit({
        unknowns: params.unknowns,
        conflicts: params.conflicts,
        saturationReasons: params.saturationReasons,
      });
      const digest = sha256Utf8(`submit-audit:${String(params.unknowns.length)}:${String(params.conflicts.length)}`);
      return {
        content: toolText("audit proposals persisted as untrusted analyst trace"),
        details: checkedResult(emptyToolResult(digest)),
      };
    },
  });
  const tools = [search, readSource, expand, relations, tests, git, scope, submitActions, submitAudit];
  if (tools.map((tool) => tool.name).join("\0") !== evidenceToolNames.join("\0")) {
    throw new Error("evidence tool factory produced a name set that is not evidenceToolNames");
  }
  return tools;
}
