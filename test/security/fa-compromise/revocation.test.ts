import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import type { ApprovalDecision, ApprovalSubject, ObjectDigest } from "@pi-hec/contracts";
import {
  ApprovalError,
  ApprovalNonceRegistry,
  GrantConsumptionRegistry,
  approvalObjectDigest,
  consumeGrant,
  freshApprovalNonce,
  issueGrantIfFaActive,
  signApprovalDecision,
  verifyDecisionAndIssueGrant,
  type ApprovalChallenge,
  type UserPresence,
} from "@pi-hec/security";
import {
  HOST_CAPABILITY,
  bootstrapTrustedWorld,
  openTempStore,
} from "../../../packages/state-store/test/helpers.js";

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const CERT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectDigest;
const POLICY =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectDigest;
const DISPLAY =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectDigest;
const DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as ObjectDigest;
const RUN = "run_01900000-0000-7000-8000-000000000025";
const APPROVAL = "approval_01900000-0000-7000-8000-000000000026";

const presence: UserPresence = {
  prove(challengeDigest) {
    return { challengeDigest, authenticatorPresent: true, coversChallenge: true };
  },
};

function subject(): ApprovalSubject {
  return {
    schemaVersion: 1,
    kind: "workspace-promotion",
    runId: RUN,
    candidateManifestObjectDigest: DIGEST,
    verdictReportObjectDigest: DIGEST,
    baseSnapshotRootDigest: DIGEST,
    currentWorkspaceRootDigest: DIGEST,
    runnerId: "runner-1",
    promotionMode: "ENTRY_JOURNALED",
  };
}

function challengeFor(subjectValue: ApprovalSubject): ApprovalChallenge {
  return {
    schemaVersion: 1,
    approvalId: APPROVAL,
    projectId: "proj-1",
    scope: { kind: "run", runId: RUN },
    action: "workspace-promotion",
    subjectObjectDigest: approvalObjectDigest("ApprovalSubject", subjectValue),
    policyObjectDigest: POLICY,
    nonce: freshApprovalNonce(),
    expiresAt: LATER,
    displayArtifactObjectDigest: DISPLAY,
  };
}

test("compromised FA cannot mint a broker-accepted grant and revocation is visible", () => {
  const ui = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  const compromisedFa = generateKeyPairSync("ed25519");
  const sub = subject();
  const challenge = challengeFor(sub);
  const decision: Omit<ApprovalDecision, "nonce"> = {
    schemaVersion: 1,
    approvalId: APPROVAL,
    projectId: "proj-1",
    principalId: "user-1",
    challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", challenge),
    subjectObjectDigest: challenge.subjectObjectDigest,
    policyObjectDigest: POLICY,
    displayArtifactObjectDigest: DISPLAY,
    decision: "APPROVE",
    decidedAt: NOW,
    expiresAt: LATER,
  };
  const signed = signApprovalDecision({
    decision,
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: presence,
    challenge,
    subject: sub,
    now: NOW,
  });

  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: signed,
      challenge,
      subject: sub,
      uiPublicKey: ui.publicKey,
      uiKeyId: "ui-1",
      brokerPrivateKey: compromisedFa.privateKey,
      brokerKeyId: "fa-forged",
      brokerCertificateObjectDigest: CERT,
      authenticatedPrincipalId: "user-1",
      nonceRegistry: new ApprovalNonceRegistry(),
      now: NOW,
    }),
  ).not.toThrow();

  const forged = verifyDecisionAndIssueGrant({
    decision: signed,
    challenge,
    subject: sub,
    uiPublicKey: ui.publicKey,
    uiKeyId: "ui-1",
    brokerPrivateKey: compromisedFa.privateKey,
    brokerKeyId: "fa-forged",
    brokerCertificateObjectDigest: CERT,
    authenticatedPrincipalId: "user-1",
    nonceRegistry: new ApprovalNonceRegistry(),
    now: NOW,
  });
  expect(() =>
    consumeGrant({
      grant: forged,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: sub,
      now: NOW,
      registry: new GrantConsumptionRegistry(),
      expectedAction: "workspace-promotion",
    }),
  ).toThrow(ApprovalError);

  const replayed = new ApprovalNonceRegistry();
  verifyDecisionAndIssueGrant({
    decision: signed,
    challenge,
    subject: sub,
    uiPublicKey: ui.publicKey,
    uiKeyId: "ui-1",
    brokerPrivateKey: broker.privateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: CERT,
    authenticatedPrincipalId: "user-1",
    nonceRegistry: replayed,
    now: NOW,
  });
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: signed,
      challenge,
      subject: sub,
      uiPublicKey: ui.publicKey,
      uiKeyId: "ui-1",
      brokerPrivateKey: broker.privateKey,
      brokerKeyId: "broker-1",
      brokerCertificateObjectDigest: CERT,
      authenticatedPrincipalId: "user-1",
      nonceRegistry: replayed,
      now: NOW,
    }),
  ).toThrow(ApprovalError);

  const opened = openTempStore();
  try {
    const world = bootstrapTrustedWorld(opened.store, "proj-fa-revoke");
    opened.store.insertRunnerCertificate(world.scope, {
      certificateSerial: "fa-serial-1",
      runnerId: world.runnerId,
      spkiSha256: "ab".repeat(32),
      notBefore: NOW,
      notAfter: LATER,
      issuedAt: NOW,
    });
    expect(opened.store.isRunnerCertificateRevoked("fa-serial-1", "ab".repeat(32))).toBe(false);
    opened.store.createRunner(world.scope, {
      runnerId: "fa-service",
      principalId: "fa-service-principal",
      platform: "linux",
      capabilityDigest: HOST_CAPABILITY,
      lastSeenAt: NOW,
    });
    opened.store.insertRunnerCertificate(world.scope, {
      certificateSerial: "fa-service-serial",
      runnerId: "fa-service",
      spkiSha256: "cd".repeat(32),
      notBefore: NOW,
      notAfter: LATER,
      issuedAt: NOW,
    });
    opened.store.revokeRunner(world.scope, {
      runnerId: world.runnerId,
      reason: "fa-compromise-drill",
      effectiveAt: NOW,
    });
    expect(opened.store.isRunnerCertificateRevoked("fa-serial-1", "ab".repeat(32))).toBe(true);
    expect(opened.store.getRunner(world.runnerId)?.revokedAt).toBe(NOW);

    const active = issueGrantIfFaActive({
      store: opened.store,
      faRunnerId: "fa-service",
      decision: signed,
      challenge,
      subject: sub,
      uiPublicKey: ui.publicKey,
      uiKeyId: "ui-1",
      brokerPrivateKey: broker.privateKey,
      brokerKeyId: "broker-1",
      brokerCertificateObjectDigest: CERT,
      authenticatedPrincipalId: "user-1",
      nonceRegistry: new ApprovalNonceRegistry(),
      now: NOW,
    });
    expect(active.payload.approvalId).toBe(APPROVAL);

    opened.store.revokeRunner(world.scope, {
      runnerId: "fa-service",
      reason: "fa-identity-compromise",
      effectiveAt: NOW,
    });
    expect(() =>
      verifyDecisionAndIssueGrant({
        store: opened.store,
        faRunnerId: "fa-service",
        decision: signed,
        challenge,
        subject: sub,
        uiPublicKey: ui.publicKey,
        uiKeyId: "ui-1",
        brokerPrivateKey: broker.privateKey,
        brokerKeyId: "broker-1",
        brokerCertificateObjectDigest: CERT,
        authenticatedPrincipalId: "user-1",
        nonceRegistry: new ApprovalNonceRegistry(),
        now: NOW,
      }),
    ).toThrow(ApprovalError);
    expect(() =>
      issueGrantIfFaActive({
        store: opened.store,
        faRunnerId: "fa-service",
        decision: signed,
        challenge,
        subject: sub,
        uiPublicKey: ui.publicKey,
        uiKeyId: "ui-1",
        brokerPrivateKey: broker.privateKey,
        brokerKeyId: "broker-1",
        brokerCertificateObjectDigest: CERT,
        authenticatedPrincipalId: "user-1",
        nonceRegistry: new ApprovalNonceRegistry(),
        now: NOW,
      }),
    ).toThrow(ApprovalError);
  } finally {
    opened.close();
  }
});
