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
  platformUserPresence,
  signApprovalDecision,
  verifyDecisionAndIssueGrant,
  type ApprovalChallenge,
  type UserPresence,
} from "../src/approval.js";

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const PAST = "2026-08-28T00:00:00.000Z";
const CERT = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectDigest;
const POLICY = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectDigest;
const DISPLAY = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectDigest;
const RUN = "run_01900000-0000-7000-8000-000000000020";
const APPROVAL = "approval_01900000-0000-7000-8000-000000000021";
const DIGEST = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as ObjectDigest;

const coveringPresence: UserPresence = {
  prove(challengeDigest) {
    return { challengeDigest, authenticatorPresent: true, coversChallenge: true };
  },
};

function keys() {
  const ui = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  return { ui, broker };
}

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

function unsignedDecision(challenge: ApprovalChallenge, decision: "APPROVE" | "DENY" = "APPROVE"): Omit<ApprovalDecision, "nonce"> {
  return {
    schemaVersion: 1,
    approvalId: APPROVAL,
    projectId: "proj-1",
    principalId: "user-1",
    challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", challenge),
    subjectObjectDigest: challenge.subjectObjectDigest,
    policyObjectDigest: POLICY,
    displayArtifactObjectDigest: DISPLAY,
    decision,
    decidedAt: NOW,
    expiresAt: LATER,
  };
}

test("approve issues a broker grant bound to workspace-promotion and consumes once", () => {
  const { ui, broker } = keys();
  const sub = subject();
  const challenge = challengeFor(sub);
  const signed = signApprovalDecision({
    decision: unsignedDecision(challenge),
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
  const nonces = new ApprovalNonceRegistry();
  const grant = verifyDecisionAndIssueGrant({
    decision: signed,
    challenge,
    subject: sub,
    uiPublicKey: ui.publicKey,
    uiKeyId: "ui-1",
    brokerPrivateKey: broker.privateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: CERT,
    authenticatedPrincipalId: "user-1",
    nonceRegistry: nonces,
    now: NOW,
  });
  expect(grant.payload.action).toBe("workspace-promotion");
  expect(grant.payload.scope).toBe("run");
  const grants = new GrantConsumptionRegistry();
  const digest = consumeGrant({
    grant,
    brokerPublicKey: broker.publicKey,
    brokerKeyId: "broker-1",
    subject: sub,
    now: NOW,
    registry: grants,
    expectedAction: "workspace-promotion",
    expectedPromotionMode: "ENTRY_JOURNALED",
  });
  expect(digest.startsWith("sha256:")).toBe(true);
  expect(() =>
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: sub,
      now: NOW,
      registry: grants,
      expectedAction: "workspace-promotion",
    }),
  ).toThrow(ApprovalError);
});

test("nonce replay, expiry, deny, and subject mismatch fail closed", () => {
  const { ui, broker } = keys();
  const sub = subject();
  const challenge = challengeFor(sub);
  const nonces = new ApprovalNonceRegistry();
  const signed = signApprovalDecision({
    decision: unsignedDecision(challenge),
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
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
    nonceRegistry: nonces,
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
      nonceRegistry: nonces,
      now: NOW,
    }),
  ).toThrow(ApprovalError);

  const expiredChallenge = { ...challenge, expiresAt: PAST };
  const expiredDecision = signApprovalDecision({
    decision: { ...unsignedDecision(expiredChallenge), expiresAt: PAST },
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge: expiredChallenge,
    subject: sub,
    now: NOW,
  });
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: expiredDecision,
      challenge: expiredChallenge,
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

  const deny = signApprovalDecision({
    decision: unsignedDecision(challenge, "DENY"),
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: deny,
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

  const commandSubject: ApprovalSubject = {
    schemaVersion: 1,
    kind: "command",
    runId: RUN,
    phase: "CANDIDATE",
    resolvedCommandSpecObjectDigest: DIGEST,
    environmentSealObjectDigest: DIGEST,
    sandboxPolicyObjectDigest: DIGEST,
    inputTreeRootDigest: DIGEST,
  };
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: signed,
      challenge,
      subject: commandSubject,
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
});

test("missing Windows Hello enrollment never becomes APPROVE", () => {
  const { ui } = keys();
  const sub = subject();
  const challenge = challengeFor(sub);
  expect(() =>
    signApprovalDecision({
      decision: unsignedDecision(challenge),
      uiPrivateKey: ui.privateKey,
      uiKeyId: "ui-1",
      signerCertificateObjectDigest: CERT,
      userPresence: platformUserPresence(),
      challenge,
      subject: sub,
      now: NOW,
    }),
  ).toThrow(ApprovalError);
  try {
    signApprovalDecision({
      decision: unsignedDecision(challenge),
      uiPrivateKey: ui.privateKey,
      uiKeyId: "ui-1",
      signerCertificateObjectDigest: CERT,
      userPresence: platformUserPresence(),
      challenge,
      subject: sub,
      now: NOW,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).reason).toBe("authenticator-absent");
  }
});

test("deny burns nonce so a later approve with the same nonce fails after restart", () => {
  const { ui, broker } = keys();
  const sub = subject();
  const challenge = challengeFor(sub);
  const durable = new ApprovalNonceRegistry();
  const deny = signApprovalDecision({
    decision: unsignedDecision(challenge, "DENY"),
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: deny,
      challenge,
      subject: sub,
      uiPublicKey: ui.publicKey,
      uiKeyId: "ui-1",
      brokerPrivateKey: broker.privateKey,
      brokerKeyId: "broker-1",
      brokerCertificateObjectDigest: CERT,
      authenticatedPrincipalId: "user-1",
      nonceRegistry: durable,
      now: NOW,
    }),
  ).toThrow(ApprovalError);
  const restarted = new ApprovalNonceRegistry(durable.snapshot());
  const approve = signApprovalDecision({
    decision: { ...unsignedDecision(challenge), nonce: deny.payload.nonce },
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
  expect(() =>
    verifyDecisionAndIssueGrant({
      decision: approve,
      challenge,
      subject: sub,
      uiPublicKey: ui.publicKey,
      uiKeyId: "ui-1",
      brokerPrivateKey: broker.privateKey,
      brokerKeyId: "broker-1",
      brokerCertificateObjectDigest: CERT,
      authenticatedPrincipalId: "user-1",
      nonceRegistry: restarted,
      now: NOW,
    }),
  ).toThrow(ApprovalError);
});

test("mode mismatch on consume fails closed", () => {
  const { ui, broker } = keys();
  const sub = subject();
  const challenge = challengeFor(sub);
  const signed = signApprovalDecision({
    decision: unsignedDecision(challenge),
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge,
    subject: sub,
    now: NOW,
  });
  const grant = verifyDecisionAndIssueGrant({
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
  expect(() =>
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: sub,
      now: NOW,
      registry: new GrantConsumptionRegistry(),
      expectedPromotionMode: "ROOT_SWAP",
    }),
  ).toThrow(ApprovalError);
});

test("approval object digests use registry schema names", () => {
  const sub = subject();
  const challenge = challengeFor(sub);
  const asDecision = approvalObjectDigest("ApprovalDecision", sub);
  const asSubject = approvalObjectDigest("ApprovalSubject", sub);
  const asChallenge = approvalObjectDigest("ApprovalChallenge", challenge);
  expect(asSubject).not.toBe(asDecision);
  expect(asChallenge).not.toBe(approvalObjectDigest("ApprovalDecision", challenge));
  expect(asSubject).toBe(challenge.subjectObjectDigest);
  expect(asChallenge).toBe(unsignedDecision(challenge).challengeObjectDigest);
});
