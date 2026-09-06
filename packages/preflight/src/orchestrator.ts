import { Compile } from "typebox/compile";
import {
  EvidenceDeltaSchema,
  type Digest,
  type EvidenceGraph,
  type EvidenceId,
  type RetrievalAction,
  type RunId,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  RETRIEVAL_CHANNEL_IDS,
  RetrievalFrontier,
  actionCanonicalDigest,
  asEvidenceId,
  applyEvidenceDelta,
  collectDeltas,
  compareUtf8,
  createRetrievalChannels,
  evidenceGraphDigest,
  mergeEvidence,
  retrieveAndFuse,
  type EvidenceChannelHost,
  type EvidenceDelta,
} from "@pi-hec/evidence";
import type { LocalSemanticAdapter } from "./local-session.js";
import {
  ANALYST_LANES,
  classifyProposedAction,
  reconstructAction,
  resolveChannelId,
} from "./actions.js";
import {
  buildClosureReport,
  closureReportDigest,
  deterministicSeed,
  evaluateClosureState,
  evaluateWitnesses,
  type ClosureEvaluation,
  type ClosureTemplate,
  type PreflightRequirement,
  type SeedInstruction,
} from "./closure/index.js";
import { actionPriority, paretoFrontier } from "./scheduler.js";
import { auditStability, compileCriticalFacets, stabilityAuditDigest } from "./stability.js";
import { persistAnalystTrace } from "./tools/scanner.js";
import type { AnalystTrace } from "./tools/scanner.js";
import { isCapabilityNode } from "./closure/templates.js";

const DELTA = Compile(EvidenceDeltaSchema);

export type PreflightTask = {
  runId: RunId;
  snapshotId: SnapshotId;
  originalRequest: string;
  closureTemplate: ClosureTemplate;
  requirements: readonly PreflightRequirement[];
};

export type PreflightResourceLimits = {
  runnerAvailable?: boolean;
  memoryBytes?: number;
  modelContextTokens?: number;
  timeoutMs?: number;
};

export type PreflightInput = {
  task: PreflightTask;
  adapter: LocalSemanticAdapter;
  channelHost: EvidenceChannelHost;
  nowIso: () => string;
  signal: AbortSignal;
  instructions?: readonly SeedInstruction[];
  extraGraph?: EvidenceGraph;
  replayActions?: readonly RetrievalAction[];
  resourceLimits?: PreflightResourceLimits;
  executeAction?: (
    action: RetrievalAction,
    graph: EvidenceGraph,
    signal: AbortSignal,
  ) => Promise<EvidenceDelta>;
};

export type PreflightResult = {
  graph: EvidenceGraph;
  closure: ReturnType<typeof buildClosureReport>;
  actionLog: readonly RetrievalAction[];
  traces: readonly AnalystTrace[];
  evaluation: ClosureEvaluation;
  closureDigest: Digest;
};

function mergeDelta(graph: EvidenceGraph, delta: EvidenceDelta): EvidenceGraph {
  if (!DELTA.Check(delta)) {
    throw new Error("evidence delta failed schema validation");
  }
  if (delta.baseEvidenceGraphObjectDigest === evidenceGraphDigest(graph)) {
    return applyEvidenceDelta(graph, delta);
  }
  return mergeEvidence(graph, delta.nodes, delta.edges);
}

function requirementCriticality(
  graph: EvidenceGraph,
  requirements: readonly PreflightRequirement[],
  action: RetrievalAction,
): number {
  let score = 0.25;
  for (const id of action.targetClaimIds) {
    const node = graph.nodes.find((item) => item.id === id);
    if (node === undefined) {
      continue;
    }
    const requirement = requirements.find((item) => node.identityKey === `requirement:${item.id}`);
    if (requirement?.priority === "MUST") {
      return 1;
    }
    if (requirement?.priority === "SHOULD") {
      score = Math.max(score, 0.5);
    }
  }
  return score;
}

function sourceIndependence(graph: EvidenceGraph, action: RetrievalAction): number {
  const channel = action.channelId;
  for (const id of action.targetClaimIds) {
    const node = graph.nodes.find((item) => item.id === id);
    if (node === undefined) {
      continue;
    }
    const used = node.provenance.some(
      (item) => item.extractorId === `pi-hec-channel-${channel}/v1`,
    );
    if (used) {
      return 0.5;
    }
  }
  return 1;
}

function unresolvedCritical(
  graph: EvidenceGraph,
  requirements: readonly PreflightRequirement[],
): EvidenceId[] {
  const witnesses = evaluateWitnesses(graph, requirements);
  const ids: EvidenceId[] = [];
  for (const witness of witnesses) {
    if (witness.status === "covered") {
      continue;
    }
    const node = graph.nodes.find(
      (item) => item.identityKey === `requirement:${witness.requirementId}`,
    );
    if (node !== undefined) {
      ids.push(asEvidenceId(node.id));
    }
  }
  for (const node of graph.nodes) {
    if (
      (node.kind === "unknown" || node.status === "unknown") &&
      !isCapabilityNode(node) &&
      node.authorship !== "LOCAL_MODEL"
    ) {
      ids.push(asEvidenceId(node.id));
    }
  }
  return [...new Set(ids)].sort(compareUtf8);
}

function resourcesFrom(input: PreflightInput): {
  aborted: boolean;
  runnerAvailable: boolean;
  memoryBytes?: number;
  modelContextTokens?: number;
  timeoutMs?: number;
} {
  const limits = input.resourceLimits ?? {};
  return {
    aborted: input.signal.aborted,
    runnerAvailable: limits.runnerAvailable !== false,
    ...(limits.memoryBytes === undefined ? {} : { memoryBytes: limits.memoryBytes }),
    ...(limits.modelContextTokens === undefined
      ? {}
      : { modelContextTokens: limits.modelContextTokens }),
    ...(limits.timeoutMs === undefined ? {} : { timeoutMs: limits.timeoutMs }),
  };
}

async function defaultExecute(
  host: EvidenceChannelHost,
  graph: EvidenceGraph,
  action: RetrievalAction,
  signal: AbortSignal,
): Promise<EvidenceDelta> {
  const bound: EvidenceChannelHost = { ...host, graph };
  const channelId = resolveChannelId(action.channelId);
  const channel = createRetrievalChannels(bound).find((item) => item.id === channelId);
  if (channel === undefined) {
    return {
      schemaVersion: 1,
      baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
      nodes: [],
      edges: [],
      unresolvedClaimIds: [...action.targetClaimIds],
      nextActions: [],
    };
  }
  const deltas = await collectDeltas(channel.expand(action, signal));
  const empty: EvidenceDelta = {
    schemaVersion: 1,
    baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
    nodes: [],
    edges: [],
    unresolvedClaimIds: [],
    nextActions: [],
  };
  return deltas.reduce((merged, delta) => {
    return {
      schemaVersion: 1,
      baseEvidenceGraphObjectDigest: evidenceGraphDigest(graph),
      nodes: [...merged.nodes, ...delta.nodes],
      edges: [...merged.edges, ...delta.edges],
      unresolvedClaimIds: [...new Set([...merged.unresolvedClaimIds, ...delta.unresolvedClaimIds])],
      nextActions: [...merged.nextActions, ...delta.nextActions],
    };
  }, empty);
}

export async function runAdaptivePreflight(input: PreflightInput): Promise<PreflightResult> {
  const traces: AnalystTrace[] = [];
  const capture = (text: string): void => {
    traces.push(persistAnalystTrace(text));
  };
  let graph = deterministicSeed(
    {
      originalRequest: input.task.originalRequest,
      snapshotId: input.task.snapshotId,
      requirements: input.task.requirements,
    },
    input.instructions ?? [],
    input.nowIso(),
  );
  if (input.extraGraph !== undefined) {
    graph = mergeEvidence(graph, input.extraGraph.nodes, input.extraGraph.edges);
  }
  const frontier = new RetrievalFrontier(input.task.snapshotId);
  const actionLog: RetrievalAction[] = [];
  const channelPulls = new Map<string, number>();
  let previousFacets = compileCriticalFacets(
    graph,
    input.task.requirements.map((item) => item.id),
  );
  let replayQueue = input.replayActions === undefined ? undefined : [...input.replayActions];
  const execute =
    input.executeAction ??
    ((action: RetrievalAction, current: EvidenceGraph, signal: AbortSignal) =>
      defaultExecute(input.channelHost, current, action, signal));

  const finish = (
    evaluation: ClosureEvaluation,
    auditDigest: ReturnType<typeof stabilityAuditDigest>,
  ): PreflightResult => {
    const closure = buildClosureReport({
      runId: input.task.runId,
      snapshotId: input.task.snapshotId,
      evaluation,
      evidenceGraphObjectDigest: evidenceGraphDigest(graph),
      exhaustedActionDigests: frontier.visitedDigests(),
      stabilityAuditObjectDigest: auditDigest,
    });
    return {
      graph,
      closure,
      actionLog,
      traces,
      evaluation,
      closureDigest: closureReportDigest(closure),
    };
  };

  for (;;) {
    if (input.signal.aborted) {
      const evaluation = evaluateClosureState({
        template: input.task.closureTemplate,
        graph,
        requirements: input.task.requirements,
        frontierFixed: false,
        channelsDrained: false,
        auditStable: false,
        resources: resourcesFrom(input),
        unresolvedCriticalEvidenceIds: unresolvedCritical(graph, input.task.requirements),
      });
      const audit = auditStability({
        graph,
        previous: previousFacets,
        actions: actionLog,
        proofObligationKeys: input.task.requirements.map((item) => item.id),
        retrievalChannelIds: RETRIEVAL_CHANNEL_IDS,
      });
      return finish(evaluation, stabilityAuditDigest(audit));
    }

    const host: EvidenceChannelHost = { ...input.channelHost, graph, runId: input.task.runId };
    const fused = await retrieveAndFuse(
      host,
      {
        runId: input.task.runId,
        snapshotId: input.task.snapshotId,
        claimIds: graph.nodes.filter((node) => node.kind === "requirement").map((node) => node.id),
        entityHints: [input.task.originalRequest.slice(0, 1024)],
        relationHints: [],
      },
      input.signal,
    );
    const beforeIds = new Set(graph.nodes.map((node) => node.id));
    graph = fused.graph;
    const unconsumedChannelDelta = fused.delta.nodes.some(
      (node) => !beforeIds.has(node.id) && !isCapabilityNode(node),
    );

    const digest = evidenceGraphDigest(graph);
    const visited = frontier.visitedDigests();
    let proposed: RetrievalAction[] = [];
    const replayHeld: RetrievalAction[] = [];
    const replayAdmissible: { raw: RetrievalAction; action: RetrievalAction }[] = [];
    if (replayQueue !== undefined) {
      for (const raw of replayQueue) {
        const classified = classifyProposedAction(input.task.snapshotId, graph, raw);
        switch (classified.kind) {
          case "admissible":
            proposed.push(classified.action);
            replayAdmissible.push({ raw, action: classified.action });
            break;
          case "pending_targets":
            replayHeld.push(raw);
            break;
          case "inadmissible":
            break;
          default: {
            const exhaustive: never = classified;
            throw new Error(`unhandled action classification ${String(exhaustive)}`);
          }
        }
      }
    } else {
      const laneResults = await Promise.all(
        ANALYST_LANES.map(async (lane) => {
          const result = await input.adapter.proposeEvidenceActions(
            {
              schemaVersion: 1,
              runId: input.task.runId,
              snapshotId: input.task.snapshotId,
              evidenceGraphObjectDigest: digest,
              lane,
              unresolvedClaimIds: unresolvedCritical(graph, input.task.requirements),
              availableChannelIds: [...RETRIEVAL_CHANNEL_IDS],
              visitedActionDigests: visited,
            },
            input.signal,
          );
          for (const action of result.actions) {
            capture(action.query);
          }
          return result.actions;
        }),
      );
      proposed = laneResults.flat();
      const audit = await input.adapter.identifyUnknownsAndConflicts(
        {
          schemaVersion: 1,
          runId: input.task.runId,
          evidenceGraphObjectDigest: digest,
          requirementIds: input.task.requirements.map((item) => item.id),
          closureTemplate: input.task.closureTemplate,
        },
        input.signal,
      );
      for (const item of [...audit.proposedUnknowns, ...audit.proposedConflicts]) {
        capture(item.statement);
      }
    }

    const admissible: RetrievalAction[] = [];
    const seenKeys = new Set<string>();
    for (const raw of proposed) {
      const reconstructed = reconstructAction(input.task.snapshotId, graph, raw);
      if (reconstructed === undefined) {
        continue;
      }
      const key = actionCanonicalDigest(input.task.snapshotId, reconstructed);
      if (seenKeys.has(key) || frontier.has(reconstructed)) {
        continue;
      }
      seenKeys.add(key);
      admissible.push(reconstructed);
    }
    const scheduled = paretoFrontier(admissible).sort((left, right) => {
      const total = actionLog.length;
      const leftScore = actionPriority(left, {
        requirementCriticality: requirementCriticality(graph, input.task.requirements, left),
        sourceIndependence: sourceIndependence(graph, left),
        channelPulls: channelPulls.get(left.channelId) ?? 0,
        totalPulls: total,
        indexCost: 1,
      });
      const rightScore = actionPriority(right, {
        requirementCriticality: requirementCriticality(graph, input.task.requirements, right),
        sourceIndependence: sourceIndependence(graph, right),
        channelPulls: channelPulls.get(right.channelId) ?? 0,
        totalPulls: total,
        indexCost: 1,
      });
      if (leftScore === rightScore) {
        return compareUtf8(
          actionCanonicalDigest(input.task.snapshotId, left),
          actionCanonicalDigest(input.task.snapshotId, right),
        );
      }
      return rightScore - leftScore;
    });

    const executed = await Promise.all(
      scheduled.map(async (action) => {
        const decision = frontier.register(action);
        if (decision === "repeat") {
          return undefined;
        }
        channelPulls.set(action.channelId, (channelPulls.get(action.channelId) ?? 0) + 1);
        const delta = await execute(action, graph, input.signal);
        return { action, delta };
      }),
    );
    for (const item of executed) {
      if (item === undefined) {
        continue;
      }
      actionLog.push(item.action);
      graph = mergeDelta(graph, item.delta);
    }
    if (replayQueue !== undefined) {
      const executedKeys = new Set(
        executed.flatMap((item) =>
          item === undefined ? [] : [actionCanonicalDigest(input.task.snapshotId, item.action)],
        ),
      );
      replayQueue = [
        ...replayHeld,
        ...replayAdmissible
          .filter(
            (item) => !executedKeys.has(actionCanonicalDigest(input.task.snapshotId, item.action)),
          )
          .map((item) => item.raw),
      ];
    }

    const audit = auditStability({
      graph,
      previous: previousFacets,
      actions: actionLog,
      proofObligationKeys: input.task.requirements.map((item) => item.id),
      retrievalChannelIds: RETRIEVAL_CHANNEL_IDS,
    });
    const frontierFixed = admissible.length === 0;
    const evaluation = evaluateClosureState({
      template: input.task.closureTemplate,
      graph,
      requirements: input.task.requirements,
      frontierFixed,
      channelsDrained: !unconsumedChannelDelta,
      auditStable: audit.stable,
      resources: resourcesFrom(input),
      unresolvedCriticalEvidenceIds: unresolvedCritical(graph, input.task.requirements),
    });
    previousFacets = audit.facets;
    if (evaluation.state === "RESOURCE_LIMITED") {
      return finish(evaluation, stabilityAuditDigest(audit));
    }
    if (
      evaluation.state === "COMPLETE" &&
      frontierFixed &&
      !unconsumedChannelDelta &&
      audit.stable
    ) {
      return finish(evaluation, stabilityAuditDigest(audit));
    }
    if (frontierFixed && !unconsumedChannelDelta) {
      return finish(
        evaluateClosureState({
          template: input.task.closureTemplate,
          graph,
          requirements: input.task.requirements,
          frontierFixed: true,
          channelsDrained: true,
          auditStable: audit.stable,
          resources: resourcesFrom(input),
          unresolvedCriticalEvidenceIds: unresolvedCritical(graph, input.task.requirements),
        }),
        stabilityAuditDigest(audit),
      );
    }
  }
}

export function seedGraph(
  task: PreflightTask,
  instructions: readonly SeedInstruction[],
  nowIso: string,
): EvidenceGraph {
  return deterministicSeed(
    {
      originalRequest: task.originalRequest,
      snapshotId: task.snapshotId,
      requirements: task.requirements,
    },
    instructions,
    nowIso,
  );
}
