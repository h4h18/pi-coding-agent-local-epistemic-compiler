import { expect, test } from "vitest";
import { actionCanonicalDigest, createRetrievalAction, RetrievalFrontier } from "../src/frontier.js";
import { collectDeltas } from "../src/claims.js";
import { emptyEvidenceGraph, evidenceGraphDigest } from "../src/graph.js";
import { SNAPSHOT_ID, TS, claimId } from "./helpers.js";
import type { ExpandableChannel } from "../src/frontier.js";

test("canonical action key is SHA-256 of snapshot, channel, normalized query and filters", () => {
  const action = createRetrievalAction({
    id: "act-1",
    channelId: "bm25",
    targetClaimIds: [claimId("c1")],
    query: "  Foo   Bar ",
    filters: { language: "typescript", path: "src/a.ts" },
  });
  const digest = actionCanonicalDigest(SNAPSHOT_ID, action);
  expect(digest.startsWith("sha256:")).toBe(true);
  const again = actionCanonicalDigest(SNAPSHOT_ID, {
    ...action,
    query: "Foo Bar",
    id: "different-id",
  });
  expect(again).toBe(digest);
});

test("expanding the same canonical key twice is a conflict no-op, not a new independent source", async () => {
  const claim = claimId("repeat");
  const action = createRetrievalAction({
    id: "act-1",
    channelId: "exact",
    targetClaimIds: [claim],
    query: "symbol",
  });
  let expansions = 0;
  const channel: ExpandableChannel = {
    async *expand() {
      expansions += 1;
      await Promise.resolve();
      yield {
        schemaVersion: 1,
        baseEvidenceGraphObjectDigest: evidenceGraphDigest(emptyEvidenceGraph(SNAPSHOT_ID)),
        nodes: [],
        edges: [],
        unresolvedClaimIds: [],
        nextActions: [],
      };
    },
  };
  const frontier = new RetrievalFrontier(SNAPSHOT_ID);
  const base = evidenceGraphDigest(emptyEvidenceGraph(SNAPSHOT_ID));
  const first = await collectDeltas(frontier.expand(channel, action, base, [claim], TS, new AbortController().signal));
  const second = await collectDeltas(
    frontier.expand(channel, { ...action, id: "act-2" }, base, [claim], TS, new AbortController().signal),
  );
  expect(expansions).toBe(1);
  expect(first[0]?.nodes).toHaveLength(0);
  expect(second[0]?.nodes).toHaveLength(1);
  expect(second[0]?.nodes[0]?.kind).toBe("conflict");
  expect(second[0]?.unresolvedClaimIds).toEqual([claim]);
  expect(second[0]?.nextActions).toEqual([]);
});
