import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { closed, DigestSchema, TimestampSchema } from "@pi-hec/contracts";

export const QUALITY_FLOOR_VERSION = "pi-hec-local-model-quality-floors/v1";

export const QUALITY_FLOORS = {
  retrievalQueryRecall: 0.7,
  rerankNdcg: 0.6,
  rerankMrr: 0.5,
  citationPrecision: 0.9,
  contradictionUnknownRecall: 0.8,
  semanticFindingPrecision: 0.85,
  jsonSchemaReliability: 0.99,
  roleIsolation: 1,
  longContextAccuracy: 0.9,
} as const;

export type QualityMetricName = keyof typeof QUALITY_FLOORS;

export const QUALITY_METRIC_NAMES = Object.keys(QUALITY_FLOORS) as readonly QualityMetricName[];

export type QualificationStatus = "unqualified" | "measured" | "selected";

export type ProfileRole = "local-llm" | "embedding" | "reranker";

export type EvidenceRef = {
  source: string;
  checkedAt: string;
  artifactSha256: string;
};

export type AdapterSurface = {
  implementsCloudCompletion: false;
  exposesRepositoryTools: false;
};

export type MetricBag = Record<QualityMetricName, number | null>;

export type LocalModelProfile = {
  kind: "local-model-profile";
  schemaVersion: 1;
  profileId: string;
  huggingfaceId: string;
  runtimeId: string;
  role: ProfileRole;
  qualificationStatus: QualificationStatus;
  selected: boolean;
  weightPin: string | null;
  advertisedNativeTokens: number;
  advertisedExtendedTokens: number | null;
  measuredContextTokens: number | null;
  measuredMaxOutputTokens?: number;
  parameterCount: number;
  metrics: MetricBag;
  peakUnifiedMemoryBytes: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  evidence: readonly EvidenceRef[];
  unqualifiedReason: string | null;
  adapterSurface: AdapterSurface;
};

export type RuntimeSlot = {
  kind: "runtime-slot";
  schemaVersion: 1;
  runtimeId: string;
  qualificationStatus: QualificationStatus;
  selected: boolean;
  unqualifiedReason: string;
  bindAddress: "127.0.0.1";
  bindPort?: number;
  evidence: readonly EvidenceRef[];
};

export type SelectedSet = {
  kind: "selected-set";
  schemaVersion: 1;
  selectedIds: readonly string[];
};

export type RoleIsolationInvariants = {
  kind: "role-isolation-invariants";
  schemaVersion: 1;
  localAdapter: AdapterSurface;
  cloudAdapter: {
    exposesRepositoryTools: false;
    allowedTerminalTools: readonly ["submit_solution", "request_context"];
  };
};

export type HostInventory = {
  kind: "host-inventory";
  schemaVersion: 1;
  collectedAt: string;
  osFamily: "windows" | "linux" | "darwin" | "other";
  osRelease: string;
  gpuNames: readonly string[];
  vramBytesByGpu: readonly (number | null)[];
  amdGpuNames: readonly string[];
  nvidiaPresent: boolean;
  cudaPresent: boolean;
  rocmPresent: boolean;
  hipPresent: boolean;
  notes: readonly string[];
};

function metricValue() {
  return Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
}

const metricProperties = {
  retrievalQueryRecall: metricValue(),
  rerankNdcg: metricValue(),
  rerankMrr: metricValue(),
  citationPrecision: metricValue(),
  contradictionUnknownRecall: metricValue(),
  semanticFindingPrecision: metricValue(),
  jsonSchemaReliability: metricValue(),
  roleIsolation: metricValue(),
  longContextAccuracy: metricValue(),
} satisfies Record<QualityMetricName, unknown>;

const QualificationStatusSchema = Type.Enum(["unqualified", "measured", "selected"] as const);

export const AdapterSurfaceSchema = closed({
  implementsCloudCompletion: Type.Literal(false),
  exposesRepositoryTools: Type.Literal(false),
});

export const EvidenceRefSchema = closed({
  source: Type.String({ minLength: 1, maxLength: 256 }),
  checkedAt: TimestampSchema,
  artifactSha256: DigestSchema,
});

export const LocalModelProfileSchema = closed({
  kind: Type.Literal("local-model-profile"),
  schemaVersion: Type.Literal(1),
  profileId: Type.String({ minLength: 1, maxLength: 256 }),
  huggingfaceId: Type.String({ minLength: 1, maxLength: 256 }),
  runtimeId: Type.String({ minLength: 1, maxLength: 256 }),
  role: Type.Enum(["local-llm", "embedding", "reranker"] as const),
  qualificationStatus: QualificationStatusSchema,
  selected: Type.Boolean(),
  weightPin: Type.Union([DigestSchema, Type.Null()]),
  advertisedNativeTokens: Type.Integer({ minimum: 0 }),
  advertisedExtendedTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  measuredContextTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  measuredMaxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  parameterCount: Type.Integer({ minimum: 0 }),
  metrics: closed(metricProperties),
  peakUnifiedMemoryBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  p50LatencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  p95LatencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  evidence: Type.Array(EvidenceRefSchema),
  unqualifiedReason: Type.Union([Type.String({ minLength: 1, maxLength: 16384 }), Type.Null()]),
  adapterSurface: AdapterSurfaceSchema,
});

export const RuntimeSlotSchema = closed({
  kind: Type.Literal("runtime-slot"),
  schemaVersion: Type.Literal(1),
  runtimeId: Type.String({ minLength: 1, maxLength: 256 }),
  qualificationStatus: QualificationStatusSchema,
  selected: Type.Boolean(),
  unqualifiedReason: Type.String({ minLength: 1, maxLength: 16384 }),
  bindAddress: Type.Literal("127.0.0.1"),
  bindPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  evidence: Type.Array(EvidenceRefSchema),
});

export const SelectedSetSchema = closed({
  kind: Type.Literal("selected-set"),
  schemaVersion: Type.Literal(1),
  selectedIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 })),
});

export const RoleIsolationInvariantsSchema = closed({
  kind: Type.Literal("role-isolation-invariants"),
  schemaVersion: Type.Literal(1),
  localAdapter: AdapterSurfaceSchema,
  cloudAdapter: closed({
    exposesRepositoryTools: Type.Literal(false),
    allowedTerminalTools: Type.Tuple([Type.Literal("submit_solution"), Type.Literal("request_context")]),
  }),
});

export const HostInventorySchema = closed({
  kind: Type.Literal("host-inventory"),
  schemaVersion: Type.Literal(1),
  collectedAt: TimestampSchema,
  osFamily: Type.Enum(["windows", "linux", "darwin", "other"] as const),
  osRelease: Type.String({ minLength: 1, maxLength: 256 }),
  gpuNames: Type.Array(Type.String({ minLength: 1, maxLength: 256 })),
  vramBytesByGpu: Type.Array(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  amdGpuNames: Type.Array(Type.String({ minLength: 1, maxLength: 256 })),
  nvidiaPresent: Type.Boolean(),
  cudaPresent: Type.Boolean(),
  rocmPresent: Type.Boolean(),
  hipPresent: Type.Boolean(),
  notes: Type.Array(Type.String({ minLength: 1, maxLength: 1024 })),
});

const localProfileValidator = Compile(LocalModelProfileSchema);
const runtimeSlotValidator = Compile(RuntimeSlotSchema);
const selectedSetValidator = Compile(SelectedSetSchema);
const roleIsolationValidator = Compile(RoleIsolationInvariantsSchema);
const hostInventoryValidator = Compile(HostInventorySchema);

export class ModelConfigError extends Error {
  readonly fileName: string;

  constructor(fileName: string, message: string) {
    super(`${fileName}: ${message}`);
    this.name = "ModelConfigError";
    this.fileName = fileName;
  }
}

export type LoadedModelConfig = {
  localProfiles: LocalModelProfile[];
  runtimeSlots: RuntimeSlot[];
  selectedIds: readonly string[];
  roleIsolation: RoleIsolationInvariants;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostInventory(raw: unknown, fileName = "host-inventory.json"): HostInventory {
  if (!hostInventoryValidator.Check(raw)) {
    throw new ModelConfigError(fileName, "failed HostInventorySchema");
  }
  return raw;
}

export async function loadModelConfigDirectory(modelsDir: string): Promise<LoadedModelConfig> {
  const names = (await readdir(modelsDir)).filter((name) => name.endsWith(".json")).sort();
  const localProfiles: LocalModelProfile[] = [];
  const runtimeSlots: RuntimeSlot[] = [];
  let selected: SelectedSet | undefined;
  let roleIsolation: RoleIsolationInvariants | undefined;
  for (const name of names) {
    if (name === "pins.json") {
      continue;
    }
    const raw: unknown = JSON.parse(await readFile(path.join(modelsDir, name), "utf8"));
    if (!isRecord(raw)) {
      throw new ModelConfigError(name, "is not a JSON object");
    }
    if (raw.kind === "local-model-profile") {
      if (!localProfileValidator.Check(raw)) {
        throw new ModelConfigError(name, "failed LocalModelProfileSchema");
      }
      localProfiles.push(raw);
      continue;
    }
    if (raw.kind === "runtime-slot") {
      if (!runtimeSlotValidator.Check(raw)) {
        throw new ModelConfigError(name, "failed RuntimeSlotSchema");
      }
      runtimeSlots.push(raw);
      continue;
    }
    if (raw.kind === "selected-set") {
      if (!selectedSetValidator.Check(raw)) {
        throw new ModelConfigError(name, "failed SelectedSetSchema");
      }
      selected = raw;
      continue;
    }
    if (raw.kind === "role-isolation-invariants") {
      if (!roleIsolationValidator.Check(raw)) {
        throw new ModelConfigError(name, "failed RoleIsolationInvariantsSchema");
      }
      roleIsolation = raw;
    }
  }
  if (selected === undefined) {
    throw new ModelConfigError("selected.json", "is missing");
  }
  if (roleIsolation === undefined) {
    throw new ModelConfigError("role-isolation.json", "is missing");
  }
  return {
    localProfiles,
    runtimeSlots,
    selectedIds: selected.selectedIds,
    roleIsolation,
  };
}

function metricMeetsFloor(profile: LocalModelProfile, name: QualityMetricName): boolean {
  const value = profile.metrics[name];
  return value !== null && value >= QUALITY_FLOORS[name];
}

export function meetsQualityFloor(profile: LocalModelProfile): boolean {
  if (profile.qualificationStatus !== "measured" && profile.qualificationStatus !== "selected") {
    return false;
  }
  if (profile.measuredContextTokens === null) {
    return false;
  }
  if (profile.peakUnifiedMemoryBytes === null) {
    return false;
  }
  if (profile.p50LatencyMs === null || profile.p95LatencyMs === null) {
    return false;
  }
  return QUALITY_METRIC_NAMES.every((name) => metricMeetsFloor(profile, name));
}

function compareEligible(left: LocalModelProfile, right: LocalModelProfile): number {
  const leftMem = left.peakUnifiedMemoryBytes ?? Number.POSITIVE_INFINITY;
  const rightMem = right.peakUnifiedMemoryBytes ?? Number.POSITIVE_INFINITY;
  if (leftMem !== rightMem) {
    return leftMem - rightMem;
  }
  if (left.parameterCount !== right.parameterCount) {
    return left.parameterCount - right.parameterCount;
  }
  if (left.huggingfaceId !== right.huggingfaceId) {
    return left.huggingfaceId < right.huggingfaceId ? -1 : 1;
  }
  if (left.profileId !== right.profileId) {
    return left.profileId < right.profileId ? -1 : 1;
  }
  return 0;
}

const ROLES: readonly ProfileRole[] = ["local-llm", "embedding", "reranker"];

export function selectLocalDeployments(profiles: readonly LocalModelProfile[]): string[] {
  const selected: string[] = [];
  for (const role of ROLES) {
    const eligible = profiles.filter((profile) => profile.role === role && meetsQualityFloor(profile));
    eligible.sort(compareEligible);
    const winner = eligible[0];
    if (winner !== undefined) {
      selected.push(winner.profileId);
    }
  }
  selected.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return selected;
}
