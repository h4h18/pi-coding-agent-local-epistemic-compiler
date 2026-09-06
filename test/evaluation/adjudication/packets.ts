import type { ExternalLabel } from "../harness/types.js";

export type BlindedAdjudicationPacket = {
  readonly packetId: string;
  readonly taskId: string;
  readonly anonymizedDiff: string;
  readonly evidence: readonly string[];
  readonly mustRequirements: readonly string[];
};

const FORBIDDEN_PACKET_KEYS = [
  "armId",
  "arm",
  "model",
  "verdict",
  "localVerdict",
  "goldPatch",
  "goldPatchRef",
  "rationale",
] as const;

export function buildBlindedPacket(input: {
  readonly packetId: string;
  readonly taskId: string;
  readonly anonymizedDiff: string;
  readonly evidence: readonly string[];
  readonly mustRequirements: readonly string[];
}): BlindedAdjudicationPacket {
  return {
    packetId: input.packetId,
    taskId: input.taskId,
    anonymizedDiff: input.anonymizedDiff,
    evidence: [...input.evidence],
    mustRequirements: [...input.mustRequirements],
  };
}

export function blindedPacketLeaks(packet: BlindedAdjudicationPacket): readonly string[] {
  const keys = Object.keys(packet);
  return FORBIDDEN_PACKET_KEYS.filter((key) => keys.includes(key));
}

export type RaterBallot = {
  readonly raterId: string;
  readonly packetId: string;
  readonly label: ExternalLabel;
};

export function aggregateBallots(input: {
  readonly first: RaterBallot;
  readonly second: RaterBallot;
  readonly tieBreaker?: RaterBallot;
}): {
  readonly label: ExternalLabel;
  readonly agreement: boolean;
  readonly tieBroken: boolean;
} {
  if (input.first.packetId !== input.second.packetId) {
    throw new Error("ballots must share a packet");
  }
  if (input.first.label === input.second.label) {
    return { label: input.first.label, agreement: true, tieBroken: false };
  }
  if (input.tieBreaker === undefined || input.tieBreaker.packetId !== input.first.packetId) {
    throw new Error("disagreement requires a tie-breaker ballot");
  }
  return { label: input.tieBreaker.label, agreement: false, tieBroken: true };
}

export function agreementRate(pairs: readonly { agreement: boolean }[]): number {
  if (pairs.length === 0) {
    return 0;
  }
  return pairs.filter((pair) => pair.agreement).length / pairs.length;
}
