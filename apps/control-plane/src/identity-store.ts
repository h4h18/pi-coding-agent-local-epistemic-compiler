import type { ObjectDigest } from "@pi-hec/contracts";
import type { StateStore } from "@pi-hec/state-store";
import type {
  CertificatePrincipalRecord,
  IdentityStorePort,
  ProjectGrantRecord,
} from "@pi-hec/security";

export class SqliteIdentityStore implements IdentityStorePort {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  lookupBySerialAndSpki(serial: string, spkiSha256: string): CertificatePrincipalRecord | undefined {
    const cert = this.#store.lookupRunnerCertificate(serial, spkiSha256);
    if (cert === undefined) {
      return undefined;
    }
    const runner = this.#store.getRunner(cert.runnerId);
    if (runner === undefined) {
      return undefined;
    }
    return {
      principalId: runner.principalId,
      identityKind: "runner",
      certificateSerial: cert.certificateSerial,
      spkiSha256: cert.spkiSha256,
      revokedAt: cert.revokedAt ?? runner.revokedAt,
      notAfter: cert.notAfter,
      audiences: ["runner"],
    };
  }

  listGrants(principalId: string): readonly ProjectGrantRecord[] {
    const runner = this.#store.getRunnerByPrincipalId(principalId);
    if (runner === undefined || runner.revokedAt !== undefined) {
      return [];
    }
    return this.#store.listRunnerProjectGrants(runner.runnerId).flatMap((grant) => {
      if (!/^sha256:[0-9a-f]{64}$/.test(grant.grantDigest)) {
        return [];
      }
      return [
        {
          projectId: grant.projectId,
          roles: ["runner"] as const,
          grantObjectDigest: grant.grantDigest as ObjectDigest,
          revokedAt: undefined,
        },
      ];
    });
  }

  listAllProjects(): readonly { projectId: string; grantObjectDigest: ObjectDigest }[] {
    return [];
  }
}
