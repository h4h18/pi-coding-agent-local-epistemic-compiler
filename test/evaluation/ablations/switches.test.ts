import { expect, test } from "vitest";
import { RETRIEVAL_CHANNEL_IDS } from "@pi-hec/evidence";
import {
  ABLATION_SWITCHES,
  applyAblation,
  CLOUD_PACKET_SCHEMA_KEYS,
  packetSchemaIdentical,
} from "./switches.js";

test("each of 18 ablations drives production channel IDs and ContextPacket keys", () => {
  expect(ABLATION_SWITCHES).toHaveLength(18);
  const calls: string[] = [];
  const ports = {
    createChannels: (host: { snapshotId: string }) => {
      calls.push(`channels:${host.snapshotId}`);
      return RETRIEVAL_CHANNEL_IDS.map((id) => ({ id }));
    },
    fuse: (rankings: readonly { channelId: string }[]) => {
      calls.push(`fuse:${rankings.map((item) => item.channelId).join(",")}`);
      return rankings.map((item) => item.channelId);
    },
    selectBundles: (input: { channelIds: readonly string[] }) => {
      calls.push(`select:${input.channelIds.join(",")}`);
      return { kind: "selected", channelIds: input.channelIds };
    },
    compile: (input: { channelIds: readonly string[]; packetKeys: readonly string[] }) => {
      calls.push(`compile:${input.channelIds.join(",")}`);
      return { packetKeys: input.packetKeys };
    },
  };
  const applied = ABLATION_SWITCHES.map((id) => applyAblation(id, { ports }));
  expect(applied).toHaveLength(18);
  expect(calls.some((item) => item.startsWith("channels:"))).toBe(true);
  expect(calls.some((item) => item.startsWith("fuse:"))).toBe(true);
  expect(calls.some((item) => item.startsWith("select:"))).toBe(true);
  expect(calls.some((item) => item.startsWith("compile:"))).toBe(true);
  const bm25 = applied.find((item) => item.switchId === "bm25-only");
  expect(bm25?.channelIds).toEqual(["bm25"]);
  expect(RETRIEVAL_CHANNEL_IDS.includes("bm25")).toBe(true);
  const dense = applied.find((item) => item.switchId === "dense-only");
  expect(dense?.channelIds).toEqual(["dense"]);
  const hybrid = applied.find((item) => item.switchId === "hybrid");
  expect(hybrid?.channelIds).toEqual(["hybrid"]);
  const none = applied.find((item) => item.switchId === "no-retrieval");
  expect(none?.channelIds).toEqual([]);
  const noTests = applied.find((item) => item.switchId === "no-runtime-tests");
  expect(noTests?.channelIds.includes("tests")).toBe(false);
  const noGit = applied.find((item) => item.switchId === "no-git-history");
  expect(noGit?.channelIds.includes("git-history")).toBe(false);
  expect(applied.find((item) => item.switchId === "no-graph")?.flags.graph).toBe(false);
  expect(
    applied.find((item) => item.switchId === "no-counter-evidence")?.flags.counterEvidence,
  ).toBe(false);
  expect(applied.find((item) => item.switchId === "fixed-topk-vs-adaptive")?.flags.closure).toBe(
    "fixed-topk",
  );
  expect(
    applied.find((item) => item.switchId === "no-path-scoped-instructions")?.flags
      .pathScopedInstructions,
  ).toBe(false);
  expect(applied.find((item) => item.switchId === "snippet-vs-structural")?.flags.bundleShape).toBe(
    "snippet",
  );
  expect(applied.find((item) => item.switchId === "random-vs-utility-order")?.flags.order).toBe(
    "random",
  );
  expect(applied.find((item) => item.switchId === "no-dedupe")?.flags.dedupe).toBe(false);
  expect(
    applied.find((item) => item.switchId === "deterministic-vs-local-guided")?.flags.retrievalGuide,
  ).toBe("deterministic");
  const guided = applyAblation("hybrid", { ports });
  const deterministic = applyAblation("deterministic-vs-local-guided", { ports });
  expect(packetSchemaIdentical(deterministic, guided)).toBe(true);
  expect(deterministic.packetKeys).toEqual([...CLOUD_PACKET_SCHEMA_KEYS]);
  expect(
    applied.find((item) => item.switchId === "local-model-variants")?.flags.localModelVariant,
  ).not.toBe("production-pin");
  expect(
    applied.find((item) => item.switchId === "context-channel-dropout")?.flags.channelDropout,
  ).toBe(true);
  expect(
    applied.find((item) => item.switchId === "stopping-model-variants")?.flags.stoppingModel,
  ).toBe("variant");
  expect(applied.find((item) => item.switchId === "verifier-layer")?.flags.verifierLayer).toBe(
    "ablated",
  );
});

test("same-channel ablations still change compile and select CompilerInput flags", () => {
  const selectInputs: Record<string, unknown>[] = [];
  const compileInputs: Record<string, unknown>[] = [];
  const ports = {
    createChannels: () => RETRIEVAL_CHANNEL_IDS.map((id) => ({ id })),
    fuse: (rankings: readonly { channelId: string }[]) => rankings,
    selectBundles: (input: Record<string, unknown>) => {
      selectInputs.push(input);
      return { kind: "selected" };
    },
    compile: (input: Record<string, unknown>) => {
      compileInputs.push(input);
      return { kind: "compiled" };
    },
  };
  const noGraph = applyAblation("no-graph", { ports });
  const snippet = applyAblation("snippet-vs-structural", { ports });
  expect(noGraph.channelIds).toEqual(snippet.channelIds);
  expect(noGraph.channelIds.length).toBeGreaterThan(0);
  expect(selectInputs).toHaveLength(2);
  expect(compileInputs).toHaveLength(2);
  const firstSelect = selectInputs[0];
  const secondSelect = selectInputs[1];
  const firstCompile = compileInputs[0];
  const secondCompile = compileInputs[1];
  if (
    firstSelect === undefined ||
    secondSelect === undefined ||
    firstCompile === undefined ||
    secondCompile === undefined
  ) {
    throw new Error("expected select/compile inputs");
  }
  expect(firstSelect.compilerInput).toEqual(expect.objectContaining({ purpose: "initial" }));
  expect(secondSelect.compilerInput).toEqual(expect.objectContaining({ purpose: "initial" }));
  expect(firstCompile.compilerInput).toEqual(expect.objectContaining({ purpose: "initial" }));
  expect(firstSelect.flags).toEqual(expect.objectContaining({ graph: false }));
  expect(secondSelect.flags).toEqual(expect.objectContaining({ bundleShape: "snippet" }));
  expect(JSON.stringify(firstSelect)).not.toEqual(JSON.stringify(secondSelect));
  expect(JSON.stringify(firstCompile)).not.toEqual(JSON.stringify(secondCompile));
  const compiled = applyAblation("hybrid");
  const compiledKind =
    compiled.compiled !== null &&
    typeof compiled.compiled === "object" &&
    "kind" in compiled.compiled
      ? compiled.compiled.kind
      : undefined;
  expect(
    compiledKind === "compiled" || compiledKind === "waiting" || compiledKind === "failed",
  ).toBe(true);
  const deterministic = applyAblation("deterministic-vs-local-guided");
  const guided = applyAblation("hybrid");
  expect(packetSchemaIdentical(deterministic, guided)).toBe(true);
});
