import { createHash, X509Certificate, type KeyObject } from "node:crypto";
import { authenticatedScopeBrand, type ObjectDigest, type PrincipalScope } from "@pi-hec/contracts";

export type IdentityKind = PrincipalScope["identityKind"];

export type CertificatePrincipalRecord = {
  principalId: string;
  identityKind: IdentityKind;
  certificateSerial: string;
  spkiSha256: string;
  revokedAt: string | undefined;
  notAfter: string;
  audiences: readonly string[];
  ed25519PublicKey?: KeyObject;
};

export type ProjectGrantRecord = {
  projectId: string;
  roles: readonly string[];
  grantObjectDigest: ObjectDigest;
  revokedAt: string | undefined;
};

export interface IdentityStorePort {
  lookupBySerialAndSpki(serial: string, spkiSha256: string): CertificatePrincipalRecord | undefined;
  listGrants(principalId: string): readonly ProjectGrantRecord[];
  listAllProjects(): readonly { projectId: string; grantObjectDigest: ObjectDigest }[];
}

export type PeerCertificateInput = {
  der: Uint8Array;
  now: string;
};

export type IdentityMappingResult =
  | { kind: "authenticated"; scope: PrincipalScope; record: CertificatePrincipalRecord }
  | { kind: "unauthenticated"; reason: "missing" | "revoked" | "expired" | "unknown" };

export function spkiSha256FromKey(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function spkiSha256FromCertificateDer(der: Uint8Array): string {
  const cert = new X509Certificate(Buffer.from(der));
  return spkiSha256FromKey(cert.publicKey);
}

export function normalizeSerial(serial: string): string {
  return serial.replaceAll(":", "").toLowerCase();
}

export function parsePeerCertificate(der: Uint8Array): {
  serial: string;
  spkiSha256: string;
  notAfter: string;
  publicKey: KeyObject;
} {
  const cert = new X509Certificate(Buffer.from(der));
  const notAfter = new Date(cert.validTo).toISOString();
  return {
    serial: normalizeSerial(cert.serialNumber),
    spkiSha256: spkiSha256FromKey(cert.publicKey),
    notAfter,
    publicKey: cert.publicKey,
  };
}

export function constructPrincipalScope(input: {
  record: CertificatePrincipalRecord;
  grants: readonly ProjectGrantRecord[];
  authenticatedAt: string;
  extraProject?: { projectId: string; roles: readonly string[]; grantObjectDigest: ObjectDigest };
}): PrincipalScope {
  const grants = input.grants
    .filter((grant) => grant.revokedAt === undefined)
    .map((grant) => ({
      projectId: grant.projectId,
      roles: [...grant.roles],
      grantObjectDigest: grant.grantObjectDigest,
    }));
  if (input.extraProject !== undefined) {
    const extra = input.extraProject;
    const exists = grants.some((grant) => grant.projectId === extra.projectId);
    if (!exists) {
      grants.push({
        projectId: extra.projectId,
        roles: [...extra.roles],
        grantObjectDigest: extra.grantObjectDigest,
      });
    }
  }
  return {
    [authenticatedScopeBrand]: true,
    principalId: input.record.principalId,
    identityKind: input.record.identityKind,
    certificateSerial: input.record.certificateSerial,
    audiences: [...input.record.audiences],
    projectGrants: grants,
    authenticatedAt: input.authenticatedAt,
  };
}

export function mapCertificateToScope(
  store: IdentityStorePort,
  input: PeerCertificateInput,
  extraProject?: { projectId: string; roles: readonly string[]; grantObjectDigest: ObjectDigest },
): IdentityMappingResult {
  const parsed = parsePeerCertificate(input.der);
  const record = store.lookupBySerialAndSpki(parsed.serial, parsed.spkiSha256);
  if (record === undefined) {
    return { kind: "unauthenticated", reason: "unknown" };
  }
  if (record.revokedAt !== undefined) {
    return { kind: "unauthenticated", reason: "revoked" };
  }
  if (input.now > record.notAfter) {
    return { kind: "unauthenticated", reason: "expired" };
  }
  const grants =
    record.identityKind === "admin"
      ? store.listAllProjects().map((project) => ({
          projectId: project.projectId,
          roles: ["admin"] as const,
          grantObjectDigest: project.grantObjectDigest,
          revokedAt: undefined,
        }))
      : store.listGrants(record.principalId);
  return {
    kind: "authenticated",
    scope: constructPrincipalScope({
      record: { ...record, ed25519PublicKey: parsed.publicKey },
      grants,
      authenticatedAt: input.now,
      ...(extraProject === undefined ? {} : { extraProject }),
    }),
    record: { ...record, ed25519PublicKey: parsed.publicKey },
  };
}

export class StaticIdentityStore implements IdentityStorePort {
  readonly #records: CertificatePrincipalRecord[];
  readonly #grants: Map<string, ProjectGrantRecord[]>;
  readonly #projects: { projectId: string; grantObjectDigest: ObjectDigest }[];

  constructor(input: {
    records: readonly CertificatePrincipalRecord[];
    grants: Readonly<Record<string, readonly ProjectGrantRecord[]>>;
    projects?: readonly { projectId: string; grantObjectDigest: ObjectDigest }[];
  }) {
    this.#records = [...input.records];
    this.#grants = new Map(
      Object.entries(input.grants).map(([principalId, grants]) => [principalId, [...grants]]),
    );
    this.#projects = input.projects === undefined ? [] : [...input.projects];
  }

  lookupBySerialAndSpki(
    serial: string,
    spkiSha256: string,
  ): CertificatePrincipalRecord | undefined {
    return this.#records.find(
      (record) => record.certificateSerial === serial && record.spkiSha256 === spkiSha256,
    );
  }

  listGrants(principalId: string): readonly ProjectGrantRecord[] {
    return this.#grants.get(principalId) ?? [];
  }

  listAllProjects(): readonly { projectId: string; grantObjectDigest: ObjectDigest }[] {
    return this.#projects;
  }

  replaceProjects(
    projects: readonly { projectId: string; grantObjectDigest: ObjectDigest }[],
  ): void {
    this.#projects.splice(0, this.#projects.length, ...projects);
  }
}

export class CompositeIdentityStore implements IdentityStorePort {
  readonly #primary: IdentityStorePort;
  readonly #fallback: IdentityStorePort;

  constructor(primary: IdentityStorePort, fallback: IdentityStorePort) {
    this.#primary = primary;
    this.#fallback = fallback;
  }

  lookupBySerialAndSpki(
    serial: string,
    spkiSha256: string,
  ): CertificatePrincipalRecord | undefined {
    return (
      this.#primary.lookupBySerialAndSpki(serial, spkiSha256) ??
      this.#fallback.lookupBySerialAndSpki(serial, spkiSha256)
    );
  }

  listGrants(principalId: string): readonly ProjectGrantRecord[] {
    const primary = this.#primary.listGrants(principalId);
    if (primary.length > 0) {
      return primary;
    }
    return this.#fallback.listGrants(principalId);
  }

  listAllProjects(): readonly { projectId: string; grantObjectDigest: ObjectDigest }[] {
    const primary = this.#primary.listAllProjects();
    if (primary.length > 0) {
      return primary;
    }
    return this.#fallback.listAllProjects();
  }
}
