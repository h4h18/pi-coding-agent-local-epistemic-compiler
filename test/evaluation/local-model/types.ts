import { type QualityMetricName } from "./quality-floors.js";

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
