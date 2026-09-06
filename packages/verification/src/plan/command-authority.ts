import type { KeyObject } from "node:crypto";
import {
  objectDigestFromBytes,
  toJsonValue,
  type ArtifactEnvelope,
  type CheckNode,
  type CommandSpec,
  type JsonValue,
  type ObjectDigest,
  type ResolvedCommandSpec,
} from "@pi-hec/contracts";
import { PlanError } from "./errors.js";
import { envelopeDigest, signArtifactEnvelope } from "./envelope.js";

const AUTHORITY_RANK: Readonly<Record<CommandSpec["authority"], number>> = {
  USER_EXPLICIT: 6,
  VERIFIER_INTRINSIC: 5,
  PROJECT_CI: 4,
  PROJECT_INSTRUCTION: 3,
  PROJECT_MANIFEST: 2,
  CLOUD_PROPOSED: 1,
};

export type SealedImageIndex = {
  readonly files: ReadonlyMap<string, ObjectDigest>;
  readonly sandboxImageObjectDigest: ObjectDigest;
  readonly safetyProfileObjectDigest: ObjectDigest;
};

export function authorityRank(authority: CommandSpec["authority"]): number {
  return AUTHORITY_RANK[authority];
}

export function approvalForCommand(spec: CommandSpec): CheckNode["approval"] {
  if (spec.authority === "CLOUD_PROPOSED") {
    return "REQUIRE_USER";
  }
  return "AUTO";
}

export function bindCommandSpecEnvelope(
  spec: CommandSpec,
  privateKey: KeyObject,
  keyId: string,
  certDigest: ObjectDigest,
  signedAt: string,
): { envelope: ArtifactEnvelope<JsonValue>; digest: ObjectDigest } {
  const envelope = signArtifactEnvelope(
    "CommandSpec",
    toJsonValue(spec),
    privateKey,
    keyId,
    certDigest,
    signedAt,
  );
  return { envelope, digest: envelopeDigest(envelope) };
}

export function resolveCommandSpec(
  spec: CommandSpec,
  sourceCommandObjectDigest: ObjectDigest,
  image: SealedImageIndex,
): ResolvedCommandSpec {
  const executablePath = normalizeSnapshotPath(spec.executable);
  const executableDigest = image.files.get(executablePath);
  if (executableDigest === undefined) {
    throw new PlanError(
      "EXECUTABLE_NOT_IN_IMAGE",
      `executable ${executablePath} is not present in the sealed image; ambient PATH is ignored`,
    );
  }
  return {
    schemaVersion: 1,
    sourceCommandObjectDigest,
    executablePath,
    executableDigest,
    argv: spec.argv,
    workingDirectory: spec.workingDirectory,
    environment: {},
    secretHandles: spec.secretHandles,
    networkDestinations: [],
    readOnlyMounts: [],
    writableRoots: spec.writableRoots,
    sandboxImageObjectDigest: image.sandboxImageObjectDigest,
    safetyProfileObjectDigest: image.safetyProfileObjectDigest,
  };
}

export function bindResolvedCommandEnvelope(
  resolved: ResolvedCommandSpec,
  privateKey: KeyObject,
  keyId: string,
  certDigest: ObjectDigest,
  signedAt: string,
): { envelope: ArtifactEnvelope<JsonValue>; digest: ObjectDigest } {
  const envelope = signArtifactEnvelope(
    "ResolvedCommandSpec",
    toJsonValue(resolved),
    privateKey,
    keyId,
    certDigest,
    signedAt,
  );
  return { envelope, digest: envelopeDigest(envelope) };
}

export function commandSpecContentDigest(spec: CommandSpec): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(JSON.stringify(toJsonValue(spec)), "utf8"));
}

function normalizeSnapshotPath(executable: string): string {
  const replaced = executable.replaceAll("\\", "/");
  const trimmed = replaced.startsWith("/") ? replaced.slice(1) : replaced;
  if (trimmed.includes("..") || trimmed.length === 0) {
    throw new PlanError("EXECUTABLE_NOT_IN_IMAGE", `illegal executable path ${executable}`);
  }
  return trimmed;
}
