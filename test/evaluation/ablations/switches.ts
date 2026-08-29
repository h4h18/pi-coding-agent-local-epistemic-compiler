import type { ContextPacket, EvidenceGraph, SnapshotId } from "@pi-hec/contracts";
import {
  RETRIEVAL_CHANNEL_IDS,
  createRetrievalChannels,
  emptyEvidenceGraph,
  fuseRankings,
  type ChannelRanking,
  type EvidenceChannelHost,
  type RetrievalChannelId,
} from "@pi-hec/evidence";
import { compileCloudContext, selectBundles, type CompilerInput } from "@pi-hec/context-compiler";
import { compilerInput } from "../../../packages/context-compiler/test/fixtures.js";

export const ABLATION_SWITCHES = [
  "no-retrieval",
  "bm25-only",
  "dense-only",
  "hybrid",
  "no-graph",
  "no-runtime-tests",
  "no-git-history",
  "no-counter-evidence",
  "fixed-topk-vs-adaptive",
  "no-path-scoped-instructions",
  "snippet-vs-structural",
  "random-vs-utility-order",
  "no-dedupe",
  "deterministic-vs-local-guided",
  "local-model-variants",
  "context-channel-dropout",
  "stopping-model-variants",
  "verifier-layer",
] as const;

export type AblationSwitch = (typeof ABLATION_SWITCHES)[number];

export const CLOUD_PACKET_SCHEMA_KEYS = [
  "schemaVersion",
  "runId",
  "snapshotId",
  "snapshotRootDigest",
  "requirementLedgerObjectDigest",
  "instructionManifestObjectDigest",
  "skillManifestObjectDigest",
  "control",
  "requirementLedger",
  "instructionManifest",
  "skillManifest",
  "authoritativeInstructions",
  "repositoryMap",
  "bundles",
  "relations",
  "evidencePayloads",
  "loadedSkills",
  "verifiedFacts",
  "unknowns",
  "conflicts",
  "risks",
  "verificationCapabilities",
  "omissionManifest",
  "tokenization",
] as const satisfies readonly (keyof ContextPacket)[];

const SNAP = "snap_01234567-89ab-7cde-8f01-23456789abcd" as SnapshotId;
const TS = "2026-08-28T00:00:00.000Z";

export type AblationFlags = {
  readonly graph: boolean;
  readonly runtimeTests: boolean;
  readonly gitHistory: boolean;
  readonly counterEvidence: boolean;
  readonly closure: "adaptive" | "fixed-topk";
  readonly pathScopedInstructions: boolean;
  readonly bundleShape: "structural" | "snippet";
  readonly order: "utility" | "random";
  readonly dedupe: boolean;
  readonly retrievalGuide: "deterministic" | "local-guided";
  readonly localModelVariant: string;
  readonly channelDropout: boolean;
  readonly stoppingModel: "production" | "variant";
  readonly verifierLayer: "full" | "ablated";
};

export type AblationChannel = { readonly id: string };

export type AblationSelectInput = {
  readonly compilerInput: CompilerInput;
  readonly flags: AblationFlags;
  readonly channelIds: readonly string[];
  readonly graph: EvidenceGraph;
  readonly closure: AblationFlags["closure"];
  readonly tokenBudget: number;
  readonly pathScopedInstructions: boolean;
  readonly bundleShape: AblationFlags["bundleShape"];
  readonly order: AblationFlags["order"];
  readonly dedupe: boolean;
  readonly retrievalGuide: AblationFlags["retrievalGuide"];
  readonly counterEvidence: boolean;
  readonly localModelVariant: string;
  readonly stoppingModel: AblationFlags["stoppingModel"];
  readonly verifierLayer: AblationFlags["verifierLayer"];
};

export type AblationCompileRequest = {
  readonly compilerInput: CompilerInput;
  readonly flags: AblationFlags;
  readonly channelIds: readonly string[];
  readonly packetKeys: readonly string[];
  readonly switchId: AblationSwitch;
};

export type AblationPorts = {
  createChannels: (host: Pick<EvidenceChannelHost, "snapshotId"> & { nowIso?: () => string }) => readonly AblationChannel[];
  fuse: (rankings: readonly { channelId: string }[], observedAt: string) => unknown;
  selectBundles: (input: AblationSelectInput) => unknown;
  compile: (input: AblationCompileRequest) => unknown;
};

export type AblationResult = {
  readonly switchId: AblationSwitch;
  readonly channelIds: readonly RetrievalChannelId[];
  readonly packetKeys: readonly (keyof ContextPacket)[];
  readonly flags: AblationFlags;
  readonly fused: unknown;
  readonly selected: unknown;
  readonly compiled: unknown;
};

const PRODUCTION_FLAGS: AblationFlags = {
  graph: true,
  runtimeTests: true,
  gitHistory: true,
  counterEvidence: true,
  closure: "adaptive",
  pathScopedInstructions: true,
  bundleShape: "structural",
  order: "utility",
  dedupe: true,
  retrievalGuide: "local-guided",
  localModelVariant: "production-pin",
  channelDropout: false,
  stoppingModel: "production",
  verifierLayer: "full",
};

export const productionAblationPorts: AblationPorts = {
  createChannels: (host) =>
    createRetrievalChannels({
      snapshotId: host.snapshotId,
      nowIso: host.nowIso ?? (() => TS),
    }),
  fuse: (rankings, observedAt) =>
    fuseRankings(
      rankings.map((ranking) => ({
        channelId: ranking.channelId as RetrievalChannelId,
        candidates: [],
      })) satisfies ChannelRanking[],
      observedAt,
    ),
  selectBundles: (input) =>
    selectBundles({
      bundles: input.compilerInput.bundles,
      graph: input.graph,
      ledger: input.compilerInput.requirementLedger,
      tokenBudget: input.tokenBudget,
      estimateBundleTokens: () => 1,
    }),
  compile: (input) => compileCloudContext(input.compilerInput),
};

function flagsFor(switchId: AblationSwitch): AblationFlags {
  switch (switchId) {
    case "no-retrieval":
      return { ...PRODUCTION_FLAGS };
    case "bm25-only":
    case "dense-only":
    case "hybrid":
      return { ...PRODUCTION_FLAGS };
    case "no-graph":
      return { ...PRODUCTION_FLAGS, graph: false };
    case "no-runtime-tests":
      return { ...PRODUCTION_FLAGS, runtimeTests: false };
    case "no-git-history":
      return { ...PRODUCTION_FLAGS, gitHistory: false };
    case "no-counter-evidence":
      return { ...PRODUCTION_FLAGS, counterEvidence: false };
    case "fixed-topk-vs-adaptive":
      return { ...PRODUCTION_FLAGS, closure: "fixed-topk" };
    case "no-path-scoped-instructions":
      return { ...PRODUCTION_FLAGS, pathScopedInstructions: false };
    case "snippet-vs-structural":
      return { ...PRODUCTION_FLAGS, bundleShape: "snippet" };
    case "random-vs-utility-order":
      return { ...PRODUCTION_FLAGS, order: "random" };
    case "no-dedupe":
      return { ...PRODUCTION_FLAGS, dedupe: false };
    case "deterministic-vs-local-guided":
      return { ...PRODUCTION_FLAGS, retrievalGuide: "deterministic" };
    case "local-model-variants":
      return { ...PRODUCTION_FLAGS, localModelVariant: "ablation-variant" };
    case "context-channel-dropout":
      return { ...PRODUCTION_FLAGS, channelDropout: true };
    case "stopping-model-variants":
      return { ...PRODUCTION_FLAGS, stoppingModel: "variant" };
    case "verifier-layer":
      return { ...PRODUCTION_FLAGS, verifierLayer: "ablated" };
    default: {
      const exhaustive: never = switchId;
      throw new Error(`unhandled ablation ${String(exhaustive)}`);
    }
  }
}

function compilerInputFor(flags: AblationFlags): CompilerInput {
  const base = compilerInput();
  return {
    ...base,
    graph: flags.graph ? base.graph : emptyEvidenceGraph(base.snapshotId),
    intendedPatchPaths: flags.pathScopedInstructions ? base.intendedPatchPaths : [],
    historicalOutputTokens: flags.stoppingModel === "production" ? base.historicalOutputTokens : [],
  };
}

function selectedChannelIds(
  switchId: AblationSwitch,
  available: readonly string[],
): RetrievalChannelId[] {
  const known = available.filter((id): id is RetrievalChannelId =>
    (RETRIEVAL_CHANNEL_IDS as readonly string[]).includes(id),
  );
  switch (switchId) {
    case "no-retrieval":
      return [];
    case "bm25-only":
      return known.filter((id) => id === "bm25");
    case "dense-only":
      return known.filter((id) => id === "dense");
    case "hybrid":
      return known.filter((id) => id === "hybrid");
    case "no-runtime-tests":
      return known.filter((id) => id !== "tests");
    case "no-git-history":
      return known.filter((id) => id !== "git-history");
    case "context-channel-dropout":
      return known.filter((id) => id !== "local-hypothesis" && id !== "external-docs");
    case "no-graph":
    case "no-counter-evidence":
    case "fixed-topk-vs-adaptive":
    case "no-path-scoped-instructions":
    case "snippet-vs-structural":
    case "random-vs-utility-order":
    case "no-dedupe":
    case "deterministic-vs-local-guided":
    case "local-model-variants":
    case "stopping-model-variants":
    case "verifier-layer":
      return [...known];
    default: {
      const exhaustive: never = switchId;
      throw new Error(`unhandled ablation ${String(exhaustive)}`);
    }
  }
}

export function applyAblation(
  switchId: AblationSwitch,
  input: { readonly ports?: Partial<AblationPorts>; readonly host?: Pick<EvidenceChannelHost, "snapshotId"> } = {},
): AblationResult {
  const ports: AblationPorts = {
    createChannels: input.ports?.createChannels ?? productionAblationPorts.createChannels,
    fuse: input.ports?.fuse ?? productionAblationPorts.fuse,
    selectBundles: input.ports?.selectBundles ?? productionAblationPorts.selectBundles,
    compile: input.ports?.compile ?? productionAblationPorts.compile,
  };
  const host = input.host ?? { snapshotId: SNAP };
  const created = ports.createChannels(host);
  const channelIds = selectedChannelIds(switchId, created.map((channel) => channel.id));
  const flags = flagsFor(switchId);
  const compiledInput = compilerInputFor(flags);
  const packetKeys = [...CLOUD_PACKET_SCHEMA_KEYS];
  const fused = ports.fuse(
    channelIds.map((channelId) => ({ channelId })),
    TS,
  );
  const graph = flags.graph ? compiledInput.graph : emptyEvidenceGraph(compiledInput.snapshotId);
  const tokenBudget = flags.closure === "fixed-topk" ? 8 : 4096;
  const selected = ports.selectBundles({
    compilerInput: compiledInput,
    flags,
    channelIds,
    graph,
    closure: flags.closure,
    tokenBudget,
    pathScopedInstructions: flags.pathScopedInstructions,
    bundleShape: flags.bundleShape,
    order: flags.order,
    dedupe: flags.dedupe,
    retrievalGuide: flags.retrievalGuide,
    counterEvidence: flags.counterEvidence,
    localModelVariant: flags.localModelVariant,
    stoppingModel: flags.stoppingModel,
    verifierLayer: flags.verifierLayer,
  });
  const compiled = ports.compile({
    compilerInput: compiledInput,
    flags,
    channelIds,
    packetKeys,
    switchId,
  });
  return {
    switchId,
    channelIds,
    packetKeys,
    flags,
    fused,
    selected,
    compiled,
  };
}

export function packetSchemaIdentical(left: AblationResult, right: AblationResult): boolean {
  if (left.packetKeys.length !== right.packetKeys.length) {
    return false;
  }
  return left.packetKeys.every((key, index) => key === right.packetKeys[index]);
}
