import { canonicalizeRfc8785, objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";

export type ArtifactClassification = "public" | "internal" | "confidential" | "restricted";

export type ExportableArtifact = {
  role: string;
  objectDigest: ObjectDigest;
  mediaType: string;
  byteSize: number;
  classification: ArtifactClassification;
  createdAt: string;
};

export type ExportManifest = {
  schemaVersion: 1;
  projectId: string;
  permittedClassification: ArtifactClassification;
  artifactObjectDigests: ObjectDigest[];
  manifestObjectDigest: ObjectDigest;
};

export const CLASSIFICATION_DENIAL = {
  httpStatus: 404 as const,
  deniedAs: "not-found" as const,
};

const RANK: Readonly<Record<ArtifactClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function classificationRank(classification: ArtifactClassification): number {
  return RANK[classification];
}

export function isClassificationPermitted(
  artifact: ArtifactClassification,
  permitted: ArtifactClassification,
): boolean {
  return classificationRank(artifact) <= classificationRank(permitted);
}

export function filterExportableArtifacts(
  artifacts: readonly ExportableArtifact[],
  permitted: ArtifactClassification,
): ExportableArtifact[] {
  return artifacts.filter((artifact) =>
    isClassificationPermitted(artifact.classification, permitted),
  );
}

export function buildExportManifest(input: {
  projectId: string;
  permittedClassification: ArtifactClassification;
  artifacts: readonly ExportableArtifact[];
}): ExportManifest {
  const selected = filterExportableArtifacts(input.artifacts, input.permittedClassification);
  const artifactObjectDigests = selected.map((artifact) => artifact.objectDigest);
  const payload = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    permittedClassification: input.permittedClassification,
    artifactObjectDigests,
  };
  return {
    ...payload,
    manifestObjectDigest: objectDigestFromBytes(Buffer.from(canonicalizeRfc8785(payload), "utf8")),
  };
}
