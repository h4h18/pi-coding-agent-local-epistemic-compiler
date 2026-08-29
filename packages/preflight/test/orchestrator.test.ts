import { expect, test } from "vitest";
import type { RetrievalAction } from "@pi-hec/contracts";
import {
  RETRIEVAL_CHANNEL_IDS,
  actionCanonicalDigest,
  createRetrievalAction,
  evidenceGraphDigest,
  normalizeQuery,
} from "@pi-hec/evidence";
import { LOCAL_TEXT_TAINT_MARKER, runAdaptivePreflight, seedGraph } from "../src/index.js";
import { predicatesFor, type ClosureTemplate } from "../src/closure/index.js";
import { auditStability, paraphraseQueries } from "../src/stability.js";
import {
  INSTRUCTIONS,
  TASK,
  TS,
  channelLocusDelta,
  createdClaimDelta,
  emptyDelta,
  graphMissingPredicate,
  instructionScopedLocusOverlay,
  mixedDependencyOverlay,
  overlayFor,
  requirementNodeId,
  satisfyingOverlay,
  silentAdapter,
} from "./preflight-helpers.js";

test("seed channels are deterministic for the same snapshot and task", () => {
  const first = seedGraph(TASK, INSTRUCTIONS, TS);
  const second = seedGraph(TASK, INSTRUCTIONS, TS);
  expect(evidenceGraphDigest(first)).toBe(evidenceGraphDigest(second));
  expect(first.nodes.some((node) => node.kind === "task")).toBe(true);
  expect(first.nodes.some((node) => node.kind === "requirement")).toBe(true);
  expect(first.nodes.some((node) => node.kind === "instruction")).toBe(true);
  const other = seedGraph({ ...TASK, originalRequest: "different task text" }, INSTRUCTIONS, TS);
  expect(evidenceGraphDigest(other)).not.toBe(evidenceGraphDigest(first));
});

test("duplicate canonical actions are not re-executed", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const action = createRetrievalAction({
    id: "act-a",
    channelId: "bm25",
    targetClaimIds: [claimId],
    query: "  parse   empty ",
    expectedInformationGain: 0.4,
    expectedTrustGain: 0.4,
    estimatedLatencyMs: 5,
    estimatedPacketTokens: 4,
  });
  const duplicate = { ...action, id: "act-b", query: "parse empty" };
  let executions = 0;
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) => (lane === "structure" ? [action, duplicate] : [])),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    executeAction: (_action, graph) => {
      executions += 1;
      return Promise.resolve(emptyDelta(graph));
    },
  });
  expect(executions).toBe(1);
  expect(result.actionLog).toHaveLength(1);
});

test("no fixed round hop or chunk cap: a larger frontier still runs to a closure state", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const total = 80;
  let executions = 0;
  const seededActions: RetrievalAction[] = [];
  for (let index = 0; index < total; index += 1) {
    seededActions.push(
      createRetrievalAction({
        id: `grow-${String(index)}`,
        channelId: "bm25",
        targetClaimIds: [claimId],
        query: `frontier-token-${String(index)}`,
        expectedInformationGain: 0.5,
        expectedTrustGain: 0.5,
        estimatedLatencyMs: 5,
        estimatedPacketTokens: 4,
      }),
    );
  }
  let proposed = false;
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) => {
      if (lane !== "structure" || proposed) {
        return [];
      }
      proposed = true;
      return seededActions;
    }),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    executeAction: (_action, graph) => {
      executions += 1;
      return Promise.resolve(emptyDelta(graph));
    },
  });
  expect(executions).toBe(total);
  expect(result.actionLog).toHaveLength(total);
  expect(["COMPLETE", "SATURATED_WITH_UNKNOWNS", "RESOURCE_LIMITED"]).toContain(result.closure.state);
  expect(result.closure.state).not.toBe("RESOURCE_LIMITED");
});

test("closure states COMPLETE, SATURATED_WITH_UNKNOWNS and RESOURCE_LIMITED are reachable and distinct", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const complete = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
  });
  const saturated = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
  });
  const aborted = new AbortController();
  aborted.abort();
  const limited = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: aborted.signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
  });
  expect(complete.closure.state).toBe("COMPLETE");
  expect(saturated.closure.state).toBe("SATURATED_WITH_UNKNOWNS");
  expect(limited.closure.state).toBe("RESOURCE_LIMITED");
  expect(new Set([complete.closure.state, saturated.closure.state, limited.closure.state]).size).toBe(3);
});

test("channel-dropout audit continues when critical loci move and COMPLETE only when stable", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const overlay = satisfyingOverlay(seeded);
  const overlayWithoutLocus = {
    ...overlay,
    edges: overlay.edges.filter((edge) => edge.relation !== "CANDIDATE_LOCUS"),
  };
  const consumer = overlay.nodes.find((node) => node.identityKey === "symbol:caller");
  if (consumer === undefined) {
    throw new Error("satisfying overlay is missing the consumer symbol");
  }
  let round = 0;
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) => {
      if (lane !== "structure") {
        return [];
      }
      round += 1;
      if (round === 1) {
        return [
          createRetrievalAction({
            id: "bm25-locus",
            channelId: "bm25",
            targetClaimIds: [claimId],
            query: "parse locus",
            expectedInformationGain: 0.6,
            expectedTrustGain: 0.6,
            estimatedLatencyMs: 5,
            estimatedPacketTokens: 4,
          }),
        ];
      }
      if (round === 2) {
        return [
          createRetrievalAction({
            id: "ast-locus",
            channelId: "ast",
            targetClaimIds: [claimId],
            query: "parse locus ast",
            expectedInformationGain: 0.6,
            expectedTrustGain: 0.6,
            estimatedLatencyMs: 5,
            estimatedPacketTokens: 4,
          }),
        ];
      }
      return [];
    }),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: overlayWithoutLocus,
    executeAction: (action, graph) =>
      Promise.resolve(
        channelLocusDelta(
          graph,
          TASK.snapshotId,
          action.channelId === "ast" ? consumer.id : claimId,
          action.channelId,
          "symbol:parse-locus",
        ),
      ),
  });
  expect(result.actionLog.length).toBeGreaterThanOrEqual(2);
  expect(result.closure.state).toBe("COMPLETE");
});

test("replay from stored actions matches live closure digest", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const live = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) =>
      lane === "structure"
        ? [
            createRetrievalAction({
              id: "live-1",
              channelId: "bm25",
              targetClaimIds: [claimId],
              query: "replay token",
              expectedInformationGain: 0.4,
              expectedTrustGain: 0.4,
              estimatedLatencyMs: 5,
              estimatedPacketTokens: 4,
            }),
          ]
        : [],
    ),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
    executeAction: (_action, graph) => Promise.resolve(emptyDelta(graph)),
  });
  const replayed = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
    replayActions: live.actionLog,
    executeAction: (_action, graph) => Promise.resolve(emptyDelta(graph)),
  });
  expect(evidenceGraphDigest(replayed.graph)).toBe(evidenceGraphDigest(live.graph));
  expect(replayed.closureDigest).toBe(live.closureDigest);
  expect(replayed.closure.state).toBe(live.closure.state);
});

test("local analyst proposals without provenance are discarded and tainted text stays out of the closure report", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const taint = "```ts\napply this patch\nrm -rf /\nhttps://evil.example/leaked-secret\n```";
  let executions = 0;
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: {
      ...silentAdapter((lane) => {
        if (lane !== "risk") {
          return [];
        }
        return [
          createRetrievalAction({
            id: "no-targets",
            channelId: "bm25",
            targetClaimIds: [],
            query: taint,
            expectedInformationGain: 0.9,
            expectedTrustGain: 0.9,
            estimatedLatencyMs: 1,
            estimatedPacketTokens: 1,
          }),
          {
            id: "unknown-claim",
            channelId: "bm25",
            targetClaimIds: ["evidence_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"],
            query: taint,
            filters: { command: "rm" },
            expectedInformationGain: 0.9,
            expectedTrustGain: 0.9,
            estimatedLatencyMs: 1,
            estimatedPacketTokens: 1,
          },
        ];
      }),
      identifyUnknownsAndConflicts: (request) =>
        Promise.resolve({
          schemaVersion: 1,
          evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
          proposedUnknowns: [
            {
              proposalId: "unknown-prose",
              kind: "unknown" as const,
              statement: taint,
              citedSourceRefs: [],
              targetClaimIds: [claimId],
              requestedReproductionActions: [],
            },
          ],
          proposedConflicts: [],
          closureCheckSuggestions: [],
        }),
    },
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
    executeAction: (_action, graph) => {
      executions += 1;
      return Promise.resolve(emptyDelta(graph));
    },
  });
  expect(executions).toBe(0);
  const serialized = JSON.stringify(result.closure);
  expect(serialized).not.toContain("leaked-secret");
  expect(serialized).not.toContain("apply this patch");
  expect(serialized).not.toContain(taint);
  expect(serialized).not.toContain(LOCAL_TEXT_TAINT_MARKER);
});

test("golden localization suite evaluates each template against a satisfying graph and a graph that misses one predicate", () => {
  const templates: ClosureTemplate[] = ["bug", "feature", "refactor", "investigation"];
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  for (const template of templates) {
    const predicates = predicatesFor(template);
    const satisfying = overlayFor(template, seeded);
    expect(predicates.length).toBeGreaterThan(0);
    for (const predicate of predicates) {
      expect(predicate.satisfied(satisfying)).toBe(true);
    }
    for (const predicate of predicates) {
      const missing = graphMissingPredicate(satisfying, predicate.id);
      expect(predicate.satisfied(missing)).toBe(false);
    }
  }
  const investigation = overlayFor("investigation", seeded);
  expect(investigation.nodes.some((node) => node.kind === "unknown")).toBe(false);
  expect(
    investigation.nodes.some(
      (node) =>
        node.authorship === "DETERMINISTIC" &&
        (node.kind === "constraint" || node.kind === "fact") &&
        node.identityKey.startsWith("uncertainty-boundary:"),
    ),
  ).toBe(true);
  expect(
    investigation.nodes.some(
      (node) =>
        node.authorship === "DETERMINISTIC" &&
        node.kind === "fact" &&
        node.identityKey.startsWith("contradiction-scan:"),
    ),
  ).toBe(true);
});

test("unique-group locus keeps dropout and independence unstable so preflight continues", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const overlay = satisfyingOverlay(seeded);
  const overlayWithoutLocus = {
    ...overlay,
    edges: overlay.edges.filter((edge) => edge.relation !== "CANDIDATE_LOCUS"),
  };
  let proposed = false;
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) => {
      if (lane !== "structure" || proposed) {
        return [];
      }
      proposed = true;
      return [
        createRetrievalAction({
          id: "bm25-only",
          channelId: "bm25",
          targetClaimIds: [claimId],
          query: "unique group locus",
          expectedInformationGain: 0.6,
          expectedTrustGain: 0.6,
          estimatedLatencyMs: 5,
          estimatedPacketTokens: 4,
        }),
      ];
    }),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: overlayWithoutLocus,
    executeAction: (action, graph) =>
      Promise.resolve(channelLocusDelta(graph, TASK.snapshotId, claimId, action.channelId, "symbol:parse-locus")),
  });
  expect(result.actionLog).toHaveLength(1);
  expect(result.closure.state).not.toBe("COMPLETE");
  expect(result.evaluation.auditStable).toBe(false);
});

test("feature refactor and investigation overlays reach COMPLETE on a real graph", async () => {
  const templates: ClosureTemplate[] = ["feature", "refactor", "investigation"];
  for (const template of templates) {
    const task = { ...TASK, closureTemplate: template };
    const seeded = seedGraph(task, INSTRUCTIONS, TS);
    const result = await runAdaptivePreflight({
      task,
      adapter: silentAdapter(),
      channelHost: { snapshotId: task.snapshotId, nowIso: () => TS, runId: task.runId },
      nowIso: () => TS,
      signal: new AbortController().signal,
      instructions: INSTRUCTIONS,
      extraGraph: overlayFor(template, seeded),
    });
    expect(result.closure.state).toBe("COMPLETE");
  }
});

test("reverse-graph permutation does not flip COMPLETE", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const overlay = satisfyingOverlay(seeded);
  const reversed = {
    schemaVersion: overlay.schemaVersion,
    snapshotId: overlay.snapshotId,
    nodes: [...overlay.nodes].reverse(),
    edges: [...overlay.edges].reverse(),
  };
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: reversed,
  });
  const audit = auditStability({
    graph: reversed,
    actions: [],
    proofObligationKeys: TASK.requirements.map((item) => item.id),
    retrievalChannelIds: RETRIEVAL_CHANNEL_IDS,
  });
  expect(audit.permutationStable).toBe(true);
  expect(result.closure.state).toBe("COMPLETE");
});

test("whitespace and combining-character paraphrases share the canonical key, different tokens do not", () => {
  const snapshotId = TASK.snapshotId;
  const filters = {};
  const original = { channelId: "bm25" as const, query: "parse empty", filters };
  const padded = { ...original, query: "  parse   empty " };
  const nfc = { ...original, query: "caf\u00e9 parse" };
  const nfd = { ...original, query: "cafe\u0301 parse" };
  const other = { ...original, query: "serialize nonempty" };
  expect(actionCanonicalDigest(snapshotId, padded)).toBe(actionCanonicalDigest(snapshotId, original));
  expect(actionCanonicalDigest(snapshotId, nfc)).toBe(actionCanonicalDigest(snapshotId, nfd));
  expect(actionCanonicalDigest(snapshotId, other)).not.toBe(actionCanonicalDigest(snapshotId, original));
  const raw = "  parse   empty ";
  const normalized = normalizeQuery(raw);
  expect(paraphraseQueries(raw).every((variant) => variant !== normalized)).toBe(true);
  expect(paraphraseQueries(raw).length).toBeGreaterThan(0);
  const action = createRetrievalAction({
    id: "para-1",
    channelId: "bm25",
    targetClaimIds: [requirementNodeId(seedGraph(TASK, INSTRUCTIONS, TS))],
    query: raw,
    expectedInformationGain: 0.4,
    expectedTrustGain: 0.4,
    estimatedLatencyMs: 5,
    estimatedPacketTokens: 4,
  });
  expect(
    auditStability({
      graph: seedGraph(TASK, INSTRUCTIONS, TS),
      actions: [action],
      proofObligationKeys: TASK.requirements.map((item) => item.id),
      retrievalChannelIds: RETRIEVAL_CHANNEL_IDS,
    }).paraphraseStable,
  ).toBe(true);
});

test("dropping load-bearing instruction nodes keeps COMPLETE false until instruction scope is stable", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const loadBearing = instructionScopedLocusOverlay(seeded);
  const unstableAudit = auditStability({
    graph: loadBearing,
    actions: [],
    proofObligationKeys: TASK.requirements.map((item) => item.id),
    retrievalChannelIds: RETRIEVAL_CHANNEL_IDS,
  });
  expect(unstableAudit.instructionScopeStable).toBe(false);
  const blocked = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: loadBearing,
  });
  expect(blocked.closure.state).not.toBe("COMPLETE");
  const stable = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
  });
  expect(stable.closure.state).toBe("COMPLETE");
  expect(stable.evaluation.auditStable).toBe(true);
});

test("mixed verified and unverified dependencies do not pass COMPLETE", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const result = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: mixedDependencyOverlay(seeded),
  });
  expect(result.closure.state).not.toBe("COMPLETE");
});

test("multi-step replay executes A then B after B's targets appear, matching live digests", async () => {
  const seeded = seedGraph(TASK, INSTRUCTIONS, TS);
  const claimId = requirementNodeId(seeded);
  const created = createdClaimDelta(seeded, TASK.snapshotId, "fact:from-action-a");
  const actionA = createRetrievalAction({
    id: "step-a",
    channelId: "bm25",
    targetClaimIds: [claimId],
    query: "create dependent claim",
    expectedInformationGain: 0.5,
    expectedTrustGain: 0.5,
    estimatedLatencyMs: 5,
    estimatedPacketTokens: 4,
  });
  const actionB = createRetrievalAction({
    id: "step-b",
    channelId: "ast",
    targetClaimIds: [created.nodeId],
    query: "consume dependent claim",
    expectedInformationGain: 0.5,
    expectedTrustGain: 0.5,
    estimatedLatencyMs: 5,
    estimatedPacketTokens: 4,
  });
  let createdSeen = false;
  const execute = (action: RetrievalAction, graph: typeof seeded) => {
    if (action.query.includes("create dependent claim")) {
      createdSeen = true;
      return Promise.resolve(createdClaimDelta(graph, TASK.snapshotId, "fact:from-action-a").delta);
    }
    return Promise.resolve(emptyDelta(graph));
  };
  const live = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter((lane) => {
      if (lane !== "structure") {
        return [];
      }
      if (!createdSeen) {
        return [actionA];
      }
      return [actionB];
    }),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
    executeAction: execute,
  });
  expect(live.actionLog).toHaveLength(2);
  expect(live.actionLog[0]?.query).toContain("create dependent claim");
  expect(live.actionLog[1]?.query).toContain("consume dependent claim");
  createdSeen = false;
  const replayed = await runAdaptivePreflight({
    task: TASK,
    adapter: silentAdapter(),
    channelHost: { snapshotId: TASK.snapshotId, nowIso: () => TS, runId: TASK.runId },
    nowIso: () => TS,
    signal: new AbortController().signal,
    instructions: INSTRUCTIONS,
    extraGraph: satisfyingOverlay(seeded),
    replayActions: live.actionLog,
    executeAction: execute,
  });
  expect(replayed.actionLog).toHaveLength(2);
  expect(evidenceGraphDigest(replayed.graph)).toBe(evidenceGraphDigest(live.graph));
  expect(replayed.closureDigest).toBe(live.closureDigest);
});
