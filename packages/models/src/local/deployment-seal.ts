import {
  selectLocalDeployments,
  type LoadedModelConfig,
  type LocalModelProfile,
  type RuntimeSlot,
} from "./deployment-config.js";
import { LocalAnalystFailure, type LocalDeploymentSeal } from "./types.js";

export const LOCAL_ANALYST_PROVIDER_ID = "hec-local";

function notPinned(message: string): LocalAnalystFailure {
  return new LocalAnalystFailure("LOCAL_MODEL_NOT_PINNED", message);
}

function requireSelectedProfile(config: LoadedModelConfig): LocalModelProfile | undefined {
  const selectedIds = new Set(config.selectedIds);
  if (selectedIds.size === 0) {
    return undefined;
  }
  const known = new Set(config.localProfiles.map((profile) => profile.profileId));
  for (const selectedId of selectedIds) {
    if (!known.has(selectedId)) {
      throw notPinned(`selected.json names unknown profile ${selectedId}`);
    }
  }
  const llmProfiles = config.localProfiles.filter(
    (profile) => profile.role === "local-llm" && selectedIds.has(profile.profileId),
  );
  const [profile, ...extra] = llmProfiles;
  if (profile === undefined) {
    return undefined;
  }
  if (extra.length > 0) {
    throw notPinned(
      `selected.json names ${String(llmProfiles.length)} local-llm profiles; exactly one local analyst is required`,
    );
  }
  return profile;
}

type QualifiedMeasurements = {
  weightPin: string;
  contextWindow: number;
  maxTokens: number;
};

function requireQualified(
  profile: LocalModelProfile,
  config: LoadedModelConfig,
): QualifiedMeasurements {
  if (!profile.selected || profile.qualificationStatus !== "selected") {
    throw notPinned(
      `profile ${profile.profileId} is selected in selected.json but not marked selected`,
    );
  }
  if (profile.weightPin === null) {
    throw notPinned(`profile ${profile.profileId} has no weight pin`);
  }
  if (profile.measuredContextTokens === null || profile.measuredContextTokens <= 0) {
    throw notPinned(`profile ${profile.profileId} has no measured context window`);
  }
  if (profile.measuredMaxOutputTokens === undefined) {
    throw notPinned(`profile ${profile.profileId} has no measured max output tokens`);
  }
  if (profile.measuredMaxOutputTokens > profile.measuredContextTokens) {
    throw notPinned(
      `profile ${profile.profileId} max output tokens exceed the measured context window`,
    );
  }
  if (
    !config.operatorPin &&
    !selectLocalDeployments(config.localProfiles).includes(profile.profileId)
  ) {
    throw notPinned(`profile ${profile.profileId} does not satisfy the quality floors`);
  }
  return {
    weightPin: profile.weightPin,
    contextWindow: profile.measuredContextTokens,
    maxTokens: profile.measuredMaxOutputTokens,
  };
}

function requireRuntimeSlot(
  profile: LocalModelProfile,
  config: LoadedModelConfig,
): RuntimeSlot & { bindPort: number } {
  const slot = config.runtimeSlots.find((candidate) => candidate.runtimeId === profile.runtimeId);
  if (slot === undefined) {
    throw notPinned(
      `runtime slot ${profile.runtimeId} referenced by ${profile.profileId} is missing`,
    );
  }
  if (!slot.selected || slot.qualificationStatus !== "selected") {
    throw notPinned(`runtime slot ${slot.runtimeId} is not selected`);
  }
  if (slot.bindPort === undefined) {
    throw notPinned(`runtime slot ${slot.runtimeId} has no loopback bind port`);
  }
  return { ...slot, bindPort: slot.bindPort };
}

export function deriveLocalDeploymentSeal(
  config: LoadedModelConfig,
): LocalDeploymentSeal | undefined {
  const profile = requireSelectedProfile(config);
  if (profile === undefined) {
    return undefined;
  }
  const measured = requireQualified(profile, config);
  const slot = requireRuntimeSlot(profile, config);
  return {
    providerId: LOCAL_ANALYST_PROVIDER_ID,
    modelId: profile.huggingfaceId,
    modelRevision: measured.weightPin,
    baseUrl: `http://${slot.bindAddress}:${String(slot.bindPort)}/v1`,
    name: profile.profileId,
    contextWindow: measured.contextWindow,
    maxTokens: measured.maxTokens,
  };
}
