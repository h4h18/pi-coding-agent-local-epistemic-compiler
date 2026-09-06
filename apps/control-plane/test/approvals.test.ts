import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { jsonBody } from "@pi-hec/client";
import { objectDigestFromBytes, type ApprovalSubject, type ObjectDigest } from "@pi-hec/contracts";
import {
  approvalObjectDigest,
  signApprovalDecision,
  type ApprovalChallenge,
} from "@pi-hec/security";
import { hostAdminScope, persistCasArtifact } from "../src/orchestration/handlers.js";
import {
  HOST_CAPABILITY,
  PROJECT_ID,
  RUN_ID,
  RUNNER_ID,
  startHarness,
  type Harness,
} from "./harness.js";

const CERT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectDigest;
const DIGEST =
  "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as ObjectDigest;

const coveringPresence = {
  prove(challengeDigest: ObjectDigest) {
    return { challengeDigest, authenticatorPresent: true as const, coversChallenge: true as const };
  },
};

function promotionSubject(): ApprovalSubject {
  return {
    schemaVersion: 1,
    kind: "workspace-promotion",
    runId: RUN_ID,
    candidateManifestObjectDigest: DIGEST,
    verdictReportObjectDigest: DIGEST,
    baseSnapshotRootDigest: DIGEST,
    currentWorkspaceRootDigest: DIGEST,
    runnerId: RUNNER_ID,
    promotionMode: "ENTRY_JOURNALED",
  };
}

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

async function persistSubject(subject: ApprovalSubject): Promise<ObjectDigest> {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return persistCasArtifact(
    harness.listening.ctx,
    hostAdminScope(harness.listening.ctx),
    PROJECT_ID,
    Buffer.from(JSON.stringify(subject), "utf8"),
    "application/json",
    "internal",
    "ApprovalSubject",
  );
}

async function runEtag(): Promise<string> {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const response = await harness.broker.call({
    operationId: "getRun",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID },
  });
  const etag = response.headers.etag;
  if (etag === undefined) {
    throw new Error("run etag missing");
  }
  return etag;
}

async function createPromotionChallenge(subjectCasDigest: ObjectDigest): Promise<{
  approvalId: string;
  challenge: ApprovalChallenge;
  challengeObjectDigest: ObjectDigest;
}> {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const etag = await runEtag();
  const created = await harness.broker.call({
    operationId: "createRunApprovalChallenge",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      action: "workspace-promotion",
      subjectObjectDigest: subjectCasDigest,
    }),
  });
  expect(created.status).toBe(201);
  const envelope = JSON.parse(created.body.toString("utf8")) as {
    payload: ApprovalChallenge;
  };
  return {
    approvalId: envelope.payload.approvalId,
    challenge: envelope.payload,
    challengeObjectDigest: objectDigestFromBytes(created.body),
  };
}

test("APPROVE issues a signed ApprovalGrant with runner verify_grant shape", async () => {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const ui = generateKeyPairSync("ed25519");
  harness.listening.ctx.signingKeys.set("ui-1", ui.publicKey);
  const subject = promotionSubject();
  const subjectCas = await persistSubject(subject);
  const opened = await createPromotionChallenge(subjectCas);
  const now = harness.clock();
  const later = new Date(Date.parse(now) + 3_600_000).toISOString();
  const signed = signApprovalDecision({
    decision: {
      schemaVersion: 1,
      approvalId: opened.approvalId,
      projectId: PROJECT_ID,
      principalId: "broker-1",
      challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", opened.challenge),
      subjectObjectDigest: opened.challenge.subjectObjectDigest,
      policyObjectDigest: opened.challenge.policyObjectDigest,
      displayArtifactObjectDigest: opened.challenge.displayArtifactObjectDigest,
      decision: "APPROVE",
      decidedAt: now,
      expiresAt: later,
    },
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-1",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge: opened.challenge,
    subject,
    now,
  });
  const etag = await runEtag();
  const committed = await harness.broker.call({
    operationId: "commitRunApproval",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID, approvalId: opened.approvalId },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      challengeObjectDigest: opened.challengeObjectDigest,
      decision: signed,
    }),
  });
  expect(committed.status).toBe(201);
  const body = JSON.parse(committed.body.toString("utf8")) as {
    outcome: string;
    grant: {
      schemaName: string;
      payload: { action: string; scope: string; runId?: string };
      signatures: readonly { keyId: string; algorithm: string; signature: string }[];
    };
  };
  expect(body.outcome).toBe("APPROVED");
  expect(body.grant.schemaName).toBe("ApprovalGrant");
  expect(body.grant.signatures).toHaveLength(1);
  expect(body.grant.signatures[0]?.signature.length).toBeGreaterThan(0);
  expect(body.grant.payload.action).toBe("workspace-promotion");
  expect(body.grant.payload.scope).toBe("run");
  expect(body.grant.payload.runId).toBe(RUN_ID);
});

test("revoked FA cannot mint a grant", async () => {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const ui = generateKeyPairSync("ed25519");
  harness.listening.ctx.signingKeys.set("ui-revoked", ui.publicKey);
  const nowRevoke = harness.clock();
  harness.store.createRunner(hostAdminScope(harness.listening.ctx), {
    runnerId: "fa-service",
    principalId: "fa-service-principal",
    platform: "windows",
    capabilityDigest: HOST_CAPABILITY,
    lastSeenAt: nowRevoke,
  });
  harness.store.revokeRunner(hostAdminScope(harness.listening.ctx), {
    runnerId: "fa-service",
    reason: "fa-compromise",
    effectiveAt: nowRevoke,
  });
  const subject = { ...promotionSubject(), runnerId: "fa-service" };
  const subjectCas = await persistSubject(subject);
  const opened = await createPromotionChallenge(subjectCas);
  const now = harness.clock();
  const later = new Date(Date.parse(now) + 3_600_000).toISOString();
  const signed = signApprovalDecision({
    decision: {
      schemaVersion: 1,
      approvalId: opened.approvalId,
      projectId: PROJECT_ID,
      principalId: "broker-1",
      challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", opened.challenge),
      subjectObjectDigest: opened.challenge.subjectObjectDigest,
      policyObjectDigest: opened.challenge.policyObjectDigest,
      displayArtifactObjectDigest: opened.challenge.displayArtifactObjectDigest,
      decision: "APPROVE",
      decidedAt: now,
      expiresAt: later,
    },
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-revoked",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge: opened.challenge,
    subject,
    now,
  });
  const etag = await runEtag();
  const committed = await harness.broker.call({
    operationId: "commitRunApproval",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID, approvalId: opened.approvalId },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      challengeObjectDigest: opened.challengeObjectDigest,
      decision: signed,
    }),
  });
  expect(committed.status).toBeGreaterThanOrEqual(400);
  const body = JSON.parse(committed.body.toString("utf8")) as { grant?: unknown; outcome?: string };
  expect(body.grant).toBeUndefined();
  expect(body.outcome).not.toBe("APPROVED");
});

test("unsigned decision is rejected and DENY returns no grant", async () => {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  const ui = generateKeyPairSync("ed25519");
  harness.listening.ctx.signingKeys.set("ui-deny", ui.publicKey);
  const subject = promotionSubject();
  const subjectCas = await persistSubject(subject);
  const unsignedChallenge = await createPromotionChallenge(subjectCas);
  const now = harness.clock();
  const later = new Date(Date.parse(now) + 3_600_000).toISOString();
  const etag = await runEtag();
  const unsigned = await harness.broker.call({
    operationId: "commitRunApproval",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID, approvalId: unsignedChallenge.approvalId },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      challengeObjectDigest: unsignedChallenge.challengeObjectDigest,
      decision: {
        schemaName: "ApprovalDecision",
        schemaVersion: 1,
        payload: {
          schemaVersion: 1,
          approvalId: unsignedChallenge.approvalId,
          projectId: PROJECT_ID,
          principalId: "broker-1",
          challengeObjectDigest: approvalObjectDigest(
            "ApprovalChallenge",
            unsignedChallenge.challenge,
          ),
          subjectObjectDigest: unsignedChallenge.challenge.subjectObjectDigest,
          policyObjectDigest: unsignedChallenge.challenge.policyObjectDigest,
          displayArtifactObjectDigest: unsignedChallenge.challenge.displayArtifactObjectDigest,
          nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          decision: "APPROVE",
          decidedAt: now,
          expiresAt: later,
        },
        payloadDigest: unsignedChallenge.challenge.subjectObjectDigest,
        signatures: [],
      },
    }),
  });
  expect(unsigned.status).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(unsigned.body.toString("utf8"))).not.toHaveProperty("grant");

  const denyOpened = await createPromotionChallenge(subjectCas);
  const signedDeny = signApprovalDecision({
    decision: {
      schemaVersion: 1,
      approvalId: denyOpened.approvalId,
      projectId: PROJECT_ID,
      principalId: "broker-1",
      challengeObjectDigest: approvalObjectDigest("ApprovalChallenge", denyOpened.challenge),
      subjectObjectDigest: denyOpened.challenge.subjectObjectDigest,
      policyObjectDigest: denyOpened.challenge.policyObjectDigest,
      displayArtifactObjectDigest: denyOpened.challenge.displayArtifactObjectDigest,
      decision: "DENY",
      decidedAt: now,
      expiresAt: later,
    },
    uiPrivateKey: ui.privateKey,
    uiKeyId: "ui-deny",
    signerCertificateObjectDigest: CERT,
    userPresence: coveringPresence,
    challenge: denyOpened.challenge,
    subject,
    now,
  });
  const denyEtag = await runEtag();
  const denied = await harness.broker.call({
    operationId: "commitRunApproval",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID, approvalId: denyOpened.approvalId },
    headers: { "content-type": "application/json", "if-match": denyEtag },
    body: jsonBody({
      schemaVersion: 1,
      challengeObjectDigest: denyOpened.challengeObjectDigest,
      decision: signedDeny,
    }),
  });
  expect(denied.status).toBe(200);
  const denyBody = JSON.parse(denied.body.toString("utf8")) as { outcome: string; grant?: unknown };
  expect(denyBody.outcome).toBe("DENIED");
  expect(denyBody.grant).toBeUndefined();
});
