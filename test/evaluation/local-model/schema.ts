import { Type, type Static } from "typebox";
import { closed, DigestSchema, TimestampSchema } from "@pi-hec/contracts";
import { QUALITY_FLOORS } from "./quality-floors.js";

const metricKeys = Object.keys(QUALITY_FLOORS) as readonly (keyof typeof QUALITY_FLOORS)[];

const metricProperties = Object.fromEntries(
  metricKeys.map((key) => [
    key,
    Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  ]),
) as {
  [K in keyof typeof QUALITY_FLOORS]: ReturnType<typeof Type.Union>;
};

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
  qualificationStatus: Type.Enum(["unqualified", "measured", "selected"] as const),
  selected: Type.Boolean(),
  weightPin: Type.Union([DigestSchema, Type.Null()]),
  advertisedNativeTokens: Type.Integer({ minimum: 0 }),
  advertisedExtendedTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  measuredContextTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
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
  qualificationStatus: Type.Enum(["unqualified", "measured", "selected"] as const),
  selected: Type.Boolean(),
  unqualifiedReason: Type.String({ minLength: 1, maxLength: 16384 }),
  bindAddress: Type.Literal("127.0.0.1"),
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
    allowedTerminalTools: Type.Tuple([
      Type.Literal("submit_solution"),
      Type.Literal("request_context"),
    ]),
  }),
});

export type LocalModelProfileSchemaType = Static<typeof LocalModelProfileSchema>;
export type RuntimeSlotSchemaType = Static<typeof RuntimeSlotSchema>;
