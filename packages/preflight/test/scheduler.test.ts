import { expect, test } from "vitest";
import { createRetrievalAction } from "@pi-hec/evidence";
import { EVIDENCE } from "./fixtures.js";
import { actionPriority, paretoFrontier, upperConfidenceBound } from "../src/scheduler.js";

test("UCB uses expected_delta_strict_pass_at_1 plus the Hoeffding bonus, never a cloud cost term", () => {
  const untried = upperConfidenceBound(0.4, 0, 10);
  const pulled = upperConfidenceBound(0.4, 4, 10);
  expect(untried).toBeGreaterThan(pulled);
  expect(pulled).toBeCloseTo(0.4 + Math.sqrt((2 * Math.log(10)) / 4), 10);
  expect(JSON.stringify({ untried, pulled })).not.toMatch(/cloud|usd|apiCost/i);
});

test("priority multiplies UCB, criticality, independence and trust, then divides by latency plus index and packet cost", () => {
  const cheap = createRetrievalAction({
    id: "cheap",
    channelId: "bm25",
    targetClaimIds: [EVIDENCE],
    query: "a",
    expectedInformationGain: 0.5,
    expectedTrustGain: 0.8,
    estimatedLatencyMs: 10,
    estimatedPacketTokens: 8,
  });
  const expensive = {
    ...cheap,
    id: "slow",
    estimatedLatencyMs: 1000,
    estimatedPacketTokens: 800,
  };
  const high = actionPriority(cheap, {
    requirementCriticality: 1,
    sourceIndependence: 1,
    channelPulls: 1,
    totalPulls: 4,
    indexCost: 1,
  });
  const low = actionPriority(expensive, {
    requirementCriticality: 1,
    sourceIndependence: 1,
    channelPulls: 1,
    totalPulls: 4,
    indexCost: 1,
  });
  expect(high).toBeGreaterThan(low);
  expect(high).toBeGreaterThan(0);
});

test("Pareto frontier drops actions that are worse on information gain, trust gain, and latency together", () => {
  const best = createRetrievalAction({
    id: "best",
    channelId: "exact",
    targetClaimIds: [EVIDENCE],
    query: "best",
    expectedInformationGain: 0.9,
    expectedTrustGain: 0.9,
    estimatedLatencyMs: 5,
    estimatedPacketTokens: 4,
  });
  const dominated = createRetrievalAction({
    id: "dominated",
    channelId: "bm25",
    targetClaimIds: [EVIDENCE],
    query: "worse",
    expectedInformationGain: 0.2,
    expectedTrustGain: 0.2,
    estimatedLatencyMs: 50,
    estimatedPacketTokens: 40,
  });
  const trade = createRetrievalAction({
    id: "trade",
    channelId: "ast",
    targetClaimIds: [EVIDENCE],
    query: "trade",
    expectedInformationGain: 0.1,
    expectedTrustGain: 0.95,
    estimatedLatencyMs: 6,
    estimatedPacketTokens: 4,
  });
  const frontier = paretoFrontier([best, dominated, trade]);
  expect(frontier.map((item) => item.id).sort()).toEqual(["best", "trade"]);
});
