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
  signApprovalDecision,
  verifyDecisionAndIssueGrant,
  type ApprovalChallenge,
  type UserPresence,
} from "@pi-hec/security";

const NOW = "2026-08-29T00:00:00.000Z";
const LATER = "2026-08-29T00:05:00.000Z";
const CERT = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectDigest;
const POLICY = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectDigest;
const DISPLAY = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectDigest;
const DIGEST = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as ObjectDigest;
const DRIFT = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as ObjectDigest;
const RUN = "run_01900000-0000-7000-8000-000000000027";
const APPROVAL = "approval_01900000-0000-7000-8000-000000000028";

const presence: UserPresence = {
  prove(challengeDigest) {
    return { challengeDigest, authenticatorPresent: true, coversChallenge: true };
  },
};

function subject(workspaceRoot: ObjectDigest = DIGEST): ApprovalSubject {
  return {
    schemaVersion: 1,
    kind: "workspace-promotion",
    runId: RUN,
    candidateManifestObjectDigest: DIGEST,
    verdictReportObjectDigest: DIGEST,
    baseSnapshotRootDigest: DIGEST,
    currentWorkspaceRootDigest: workspaceRoot,
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

test("approval replay and workspace-root TOCTOU fail closed", () => {
  const ui = generateKeyPairSync("ed25519");
  const broker = generateKeyPairSync("ed25519");
  const approved = subject();
  const challenge = challengeFor(approved);
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
    subject: approved,
    now: NOW,
  });
  const nonces = new ApprovalNonceRegistry();
  const grant = verifyDecisionAndIssueGrant({
    decision: signed,
    challenge,
    subject: approved,
    uiPublicKey: ui.publicKey,
    uiKeyId: "ui-1",
    brokerPrivateKey: broker.privateKey,
    brokerKeyId: "broker-1",
    brokerCertificateObjectDigest: CERT,
    authenticatedPrincipalId: "user-1",
    nonceRegistry: nonces,
    now: NOW,
  });
  const grants = new GrantConsumptionRegistry();
  consumeGrant({
    grant,
    brokerPublicKey: broker.publicKey,
    brokerKeyId: "broker-1",
    subject: approved,
    now: NOW,
    registry: grants,
    expectedAction: "workspace-promotion",
  });
  expect(() =>
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: approved,
      now: NOW,
      registry: grants,
      expectedAction: "workspace-promotion",
    }),
  ).toThrow(ApprovalError);

  expect(() =>
    consumeGrant({
      grant,
      brokerPublicKey: broker.publicKey,
      brokerKeyId: "broker-1",
      subject: subject(DRIFT),
      now: NOW,
      registry: new GrantConsumptionRegistry(),
      expectedAction: "workspace-promotion",
    }),
  ).toThrow(ApprovalError);
});
