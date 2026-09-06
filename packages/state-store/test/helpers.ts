import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  asObjectDigest,
  authenticatedScopeBrand,
  canonicalizeRfc8785,
  enterStateEvent,
  sha256Utf8,
  type ObjectDigest,
  type PrincipalScope,
  type ProjectScope,
  type RunDomainEvent,
  type RunId,
  type RunProjection,
  type RunState,
  type VerifiedArtifactSet,
} from "@pi-hec/domain";
import {
  ARGON2ID_TEST_PARAMETERS,
  defaultControlMigrationsDir,
  openStateStore,
  type ArtifactInput,
  type HostAuthorityArtifactInput,
  type StateStore,
} from "../src/index.js";

export const NOW = "2026-08-28T00:00:00.000Z";
export const LATER = "2026-08-28T01:00:00.000Z";
export const HOST_SIGNER = digestOf("host-signer-cert");
export const HOST_POLICY = digestOf("host-policy");
export const HOST_CAPABILITY = digestOf("host-runner-capability");
export const HOST_GRANT_POLICY = digestOf("host-runner-grant-policy");

let nonceCounter = 0;

export function digestOf(label: string): ObjectDigest {
  return asObjectDigest(sha256Utf8(label));
}

export function payloadDigestOf(payload: unknown): ObjectDigest {
  return asObjectDigest(sha256Utf8(canonicalizeRfc8785(payload)));
}

export function nextNonce(): string {
  nonceCounter += 1;
  return nonceCounter.toString(16).padStart(24, "0");
}

export function testKeys(): { hostLeaseKey: Buffer; dbResponseKey: Buffer } {
  return {
    hostLeaseKey: createHash("sha256").update("host-lease-key").digest(),
    dbResponseKey: createHash("sha256").update("db-response-key").digest(),
  };
}

export function principalScope(projectIds: readonly string[], principalId = "admin-1"): PrincipalScope {
  return {
    [authenticatedScopeBrand]: true,
    principalId,
    identityKind: "admin",
    certificateSerial: "serial-admin",
    audiences: ["control"],
    projectGrants: projectIds.map((projectId) => ({
      projectId,
      roles: ["admin"],
      grantObjectDigest: digestOf(`grant:${projectId}`),
    })),
    authenticatedAt: NOW,
  };
}

export type OpenedStore = {
  store: StateStore;
  dir: string;
  dbPath: string;
  keys: { hostLeaseKey: Buffer; dbResponseKey: Buffer };
  close: () => void;
};

export function openTempStore(): OpenedStore {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-hec-state-"));
  const dbPath = path.join(dir, "control.sqlite");
  const keys = testKeys();
  const store = openStateStore({
    dbPath,
    hostLeaseKey: keys.hostLeaseKey,
    dbResponseKey: keys.dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
    appliedAt: NOW,
  });
  return {
    store,
    dir,
    dbPath,
    keys,
    close: () => {
      try {
        store.close();
      } catch {
        // already closed after simulated termination
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function reopenStore(opened: OpenedStore): StateStore {
  try {
    opened.store.close();
  } catch {
    // already closed
  }
  return openStateStore({
    dbPath: opened.dbPath,
    hostLeaseKey: opened.keys.hostLeaseKey,
    dbResponseKey: opened.keys.dbResponseKey,
    migrationsDir: defaultControlMigrationsDir(),
    argon2: ARGON2ID_TEST_PARAMETERS,
    appliedAt: NOW,
  });
}

export function hostArtifact(objectDigest: string, label: string): HostAuthorityArtifactInput {
  return {
    objectDigest,
    schemaName: "HostAuthority",
    mediaType: "application/json",
    byteSize: 32,
    encryptionKeyId: `host-key:${label}`,
    encryptionNonce: nextNonce(),
    signatureKeyId: "host-sign",
    signature: "c2ln",
    createdAt: NOW,
  };
}

export function artifact(digest: ObjectDigest, schemaName: string | null, label: string): ArtifactInput {
  return {
    digest,
    schemaName,
    mediaType: "application/json",
    byteSize: 16,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: `cas:${label}`,
    encryptionNonce: nextNonce(),
    storageRecordDigest: digestOf(`storage:${label}`),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: NOW,
    storageRecordSignerCertificateDigest: HOST_SIGNER,
    storageRecordSignature: "c2lnbmF0dXJl",
    createdAt: NOW,
  };
}

export type World = {
  scope: PrincipalScope;
  projectScope: ProjectScope;
  projectId: string;
  workspaceId: string;
  runnerId: string;
};

export function bootstrapTrustedWorld(store: StateStore, projectId: string): World {
  const scope = principalScope([projectId]);
  seedHostAuthority(store);
  const policyDigest = digestOf(`policy:${projectId}`);
  store.createUntrustedProject(scope, {
    projectId,
    displayName: projectId,
    classification: "internal",
    policy: artifact(policyDigest, "ProjectPolicy", `policy:${projectId}`),
    createdAt: NOW,
  });
  const projectScope = store.toProjectScope(scope, projectId);
  const subject = digestOf(`subject:${projectId}`);
  const display = digestOf(`display:${projectId}`);
  const challenge = digestOf(`challenge:${projectId}`);
  const decision = digestOf(`decision:${projectId}`);
  const grant = digestOf(`grant-art:${projectId}`);
  store.putArtifact(projectScope, artifact(subject, "ApprovalSubject", `subject:${projectId}`));
  store.putArtifact(projectScope, artifact(display, "ApprovalChallenge", `display:${projectId}`));
  store.putArtifact(projectScope, artifact(challenge, "ApprovalChallenge", `challenge:${projectId}`));
  store.putArtifact(projectScope, artifact(decision, "ApprovalDecision", `decision:${projectId}`));
  store.putArtifact(projectScope, artifact(grant, "ApprovalGrant", `grant:${projectId}`));
  store.setProjectTrust(scope, {
    projectId,
    nextTrustState: "trusted",
    approvalId: `trust-${projectId}`,
    principalId: scope.principalId,
    subjectDigest: subject,
    hostPolicyDigest: HOST_POLICY,
    challengeDigest: challenge,
    decisionDigest: decision,
    grantDigest: grant,
    displayArtifactDigest: display,
    nonceHash: digestOf(`nonce:${projectId}`),
    expiresAt: LATER,
    createdAt: NOW,
    consumedAt: NOW,
    outcome: "approved",
  });
  const runnerId = "runner-shared";
  try {
    store.createRunner(scope, {
      runnerId,
      principalId: "runner-principal",
      platform: "win32",
      capabilityDigest: HOST_CAPABILITY,
      lastSeenAt: NOW,
    });
  } catch {
    // runner is host-global
  }
  store.grantRunnerProject(projectScope, {
    runnerId,
    capabilityPolicyDigest: HOST_GRANT_POLICY,
    createdAt: NOW,
  });
  const broker = digestOf(`broker:${projectId}`);
  const registration = digestOf(`registration:${projectId}`);
  store.putArtifact(projectScope, artifact(broker, null, `broker:${projectId}`));
  store.putArtifact(projectScope, artifact(registration, "ApprovalGrant", `registration:${projectId}`));
  const workspaceId = `ws-${projectId}`;
  store.createWorkspace(projectScope, {
    workspaceId,
    runnerId,
    rootFingerprint: `fp-${projectId}`,
    platform: "win32",
    brokerAttestationDigest: broker,
    registrationGrantDigest: registration,
    createdAt: NOW,
  });
  return { scope, projectScope, projectId, workspaceId, runnerId };
}

export function seedHostAuthority(store: StateStore): void {
  for (const item of [
    hostArtifact(HOST_SIGNER, "signer"),
    hostArtifact(HOST_POLICY, "policy"),
    hostArtifact(HOST_CAPABILITY, "capability"),
    hostArtifact(HOST_GRANT_POLICY, "grant-policy"),
  ]) {
    try {
      store.putHostAuthorityArtifact(item);
    } catch {
      // already inserted in this database
    }
  }
}

export function verified(
  bindings: readonly { role: string; objectDigest: ObjectDigest }[],
): VerifiedArtifactSet {
  return {
    bindings,
    signaturesValid: true,
    satisfiedGuards: new Set(),
  };
}

export function enterEvent(projection: RunProjection, target: RunState, eventId: string): RunDomainEvent {
  return enterStateEvent({
    eventId,
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType: "control",
    actorId: "actor-control",
    occurredAt: NOW,
    target,
    reasonCode: "phase",
  });
}

export function cancelEvent(projection: RunProjection, eventId: string): RunDomainEvent {
  return {
    schemaVersion: 1,
    eventId,
    projectId: projection.projectId,
    runId: projection.runId,
    expectedStateVersion: projection.stateVersion,
    actorType: "user",
    actorId: "actor-user",
    occurredAt: NOW,
    eventType: "USER_CANCELLATION_REQUESTED",
    payload: { reason: "user-cancel" },
  };
}

export function putPayload(store: StateStore, scope: ProjectScope, event: RunDomainEvent): ObjectDigest {
  const digest = payloadDigestOf(event.payload);
  store.putArtifact(scope, artifact(digest, null, event.eventId));
  return digest;
}

export function persistEnter(
  store: StateStore,
  scope: ProjectScope,
  projection: RunProjection,
  target: RunState,
  artifacts: VerifiedArtifactSet,
  eventId: string,
): RunProjection {
  const event = enterEvent(projection, target, eventId);
  const payloadDigest = putPayload(store, scope, event);
  return store.persistRunEvent(scope, { event, artifacts, payloadDigest });
}

export function createTaskRun(
  store: StateStore,
  world: World,
  runId: RunId,
  taskDigest: ObjectDigest = digestOf(`task:${world.projectId}:${runId}`),
): { projection: RunProjection; taskDigest: ObjectDigest } {
  store.putArtifact(world.projectScope, artifact(taskDigest, "TaskEnvelope", `task:${runId}`));
  const projection = store.createRun(world.projectScope, {
    runId,
    workspaceId: world.workspaceId,
    taskEnvelopeDigest: taskDigest,
    createdAt: NOW,
  });
  return { projection, taskDigest };
}

export function runIdFor(suffix: string): RunId {
  const body = `01900000-0000-7000-8000-00000000${suffix.padStart(4, "0")}`;
  return `run_${body}`;
}

export function opIdFor(suffix: string): `op_${string}` {
  const body = `01900000-0000-7000-8000-00000000${suffix.padStart(4, "0")}`;
  return `op_${body}`;
}

export function randomSecret(): Uint8Array {
  return randomBytes(16);
}
