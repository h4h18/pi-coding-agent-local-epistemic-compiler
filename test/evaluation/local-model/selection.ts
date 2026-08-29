import { QUALITY_FLOORS, type QualityMetricName } from "./quality-floors.js";
import { type LocalModelProfile, type ProfileRole } from "./types.js";

function metricMeetsFloor(profile: LocalModelProfile, name: QualityMetricName): boolean {
  const value = profile.metrics[name];
  return value !== null && value >= QUALITY_FLOORS[name];
}

function meetsQualityFloor(profile: LocalModelProfile): boolean {
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
  for (const name of Object.keys(QUALITY_FLOORS) as QualityMetricName[]) {
    if (!metricMeetsFloor(profile, name)) {
      return false;
    }
  }
  return true;
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

export type { LocalModelProfile };
