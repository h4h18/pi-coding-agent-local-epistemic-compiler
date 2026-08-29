import type {
  BaselineSeal,
  CheckNode,
  CommandSpec,
  Digest,
  EvidenceRecord,
  ObjectDigest,
  ProofObligation,
  RunObservation,
  SnapshotId,
  VerificationCapability,
} from "@pi-hec/contracts";

export type ProducerHost = {
  listPaths(): readonly string[];
  readText(path: string): string | undefined;
  commands(): readonly CommandSpec[];
};

export type ArtifactStore = {
  getText(digest: string): string | undefined;
};

export type ProducerBindings = {
  baselineSealObjectDigest: ObjectDigest;
  environmentSealObjectDigest: ObjectDigest;
  snapshotId: SnapshotId;
  snapshotRootDigest: Digest;
  candidateManifestObjectDigest: ObjectDigest;
};

export type EvidenceProducer = {
  readonly id: string;
  readonly versionObjectDigest: ObjectDigest;
  probe(seal: BaselineSeal): Promise<readonly VerificationCapability[]>;
  plan(
    obligation: ProofObligation,
    capabilities: readonly VerificationCapability[],
  ): Promise<readonly CheckNode[]>;
  parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]>;
};

export function subjectFor(check: CheckNode, bindings: ProducerBindings): EvidenceRecord["subject"] {
  if (check.subject === "BASELINE") {
    return {
      kind: "BASELINE",
      snapshotId: bindings.snapshotId,
      snapshotRootDigest: bindings.snapshotRootDigest,
    };
  }
  return {
    kind: "CANDIDATE",
    candidateManifestObjectDigest: bindings.candidateManifestObjectDigest,
  };
}

export function memoryHost(
  files: Readonly<Record<string, string>>,
  commands: readonly CommandSpec[] = [],
): ProducerHost {
  const map = new Map(Object.entries(files));
  return {
    listPaths: () => [...map.keys()],
    readText: (path) => map.get(path),
    commands: () => commands,
  };
}

export function memoryArtifacts(entries: Readonly<Record<string, string>>): ArtifactStore {
  const map = new Map(Object.entries(entries));
  return {
    getText: (digest) => map.get(digest),
  };
}
