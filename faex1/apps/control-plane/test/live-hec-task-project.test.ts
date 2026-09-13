import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { ControlPlaneClient, jsonBody } from "@pi-hec/client";
import { objectDigestFromBytes } from "@pi-hec/contracts";
import { contentDigestSha256 } from "@pi-hec/security";
import { createMutationSigner } from "../src/host-runtime.js";
import { newApprovalId, newOperationId } from "../src/orchestration/handlers.js";
import { createCsrPem, pem as encodePem, signProofOfPossession } from "../src/pki.js";
import { createProjectBody, parseJson } from "./harness.js";

const live = process.env.PI_HEC_LIVE_STACK === "1";
const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT ?? "https://10.10.10.184:8443";
const enrollEndpoint = process.env.PI_HEC_ENROLL_ENDPOINT ?? "https://10.10.10.184:8444";
const pkiDir = process.env.PI_HEC_CLIENT_PKI ?? path.join(os.homedir(), ".pi-hec", "pki");
const projectId = process.env.PI_HEC_PROJECT_ID ?? "live.hec.task";
const workspaceId = process.env.PI_HEC_WORKSPACE_ID ?? "pi-hec-prod-e2e";
const runnerId = process.env.PI_HEC_RUNNER_ID ?? "win.broker.1";

function pem(name: string): Buffer {
  return readFileSync(path.join(pkiDir, name));
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label);
  }
  return value;
}

function readTrustState(body: unknown): string {
  const root = asObject(body, "project body");
  const nested = root.project;
  const project = nested === undefined ? root : asObject(nested, "project");
  const trustState = Reflect.get(project, "trustState");
  if (typeof trustState !== "string") {
    throw new Error("trustState");
  }
  return trustState;
}

const required = [
  "ca.crt.pem",
  "admin.crt.pem",
  "admin.key.pem",
  "admin.sign.key.pem",
  "broker.crt.pem",
  "broker.key.pem",
  "broker.sign.key.pem",
];
const ready = live && required.every((name) => existsSync(path.join(pkiDir, name)));
const clients: ControlPlaneClient[] = [];

afterAll(() => {
  for (const client of clients) {
    client.close();
  }
});

test.skipIf(!ready)("admin trusts the live HEC project and broker registers its workspace", async () => {
  const host = new URL(endpoint).hostname;
  const tls = {
    ca: pem("ca.crt.pem"),
    servername: host,
  };
  const admin = new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ...tls,
      cert: pem("admin.crt.pem"),
      key: pem("admin.key.pem"),
    },
    enrollTls: tls,
    signer: createMutationSigner(createPrivateKey(pem("admin.sign.key.pem")), "admin-1"),
  });
  const broker = new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ...tls,
      cert: pem("broker.crt.pem"),
      key: pem("broker.key.pem"),
    },
    enrollTls: tls,
    signer: createMutationSigner(createPrivateKey(pem("broker.sign.key.pem")), "broker-1"),
  });
  clients.push(admin, broker);

  const created = await admin.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody(projectId)),
    headers: { "content-type": "application/json" },
  });
  const existing = await admin.call({
    operationId: "getProject",
    pathParams: { projectId },
  });
  expect(existing.status).toBe(200);
  if (created.status === 201) {
    expect(readTrustState(parseJson(created.body))).toBe("untrusted");
  }
  expect(Reflect.get(asObject(parseJson(existing.body), "getProject"), "projectId")).toBe(projectId);

  if (readTrustState(parseJson(existing.body)) !== "trusted") {
    const etag = existing.headers.etag;
    expect(etag).toEqual(expect.any(String));
    const trusted = await admin.call({
      operationId: "setProjectTrust",
      pathParams: { projectId },
      body: jsonBody({
        schemaVersion: 1,
        trustState: "trusted",
        approvalId: newApprovalId(),
      }),
      headers: {
        "content-type": "application/json",
        "if-match": etag ?? "",
      },
    });
    expect(trusted.status).toBe(200);
    expect(readTrustState(parseJson(trusted.body))).toBe("trusted");
  }

  const challengeBody = jsonBody({
    schemaVersion: 1,
    permittedProjectIds: [projectId],
    runnerPlatform: "windows",
    expiresInSeconds: 3600,
  });
  const challenge = await admin.call({
    operationId: "createRunnerEnrollmentChallenge",
    body: challengeBody,
    headers: { "content-type": "application/json" },
  });
  expect(challenge.status).toBe(201);
  const challengeJson = asObject(parseJson(challenge.body), "enrollment challenge");
  const challengeId = challengeJson.challengeId;
  const oneTimeSecret = challengeJson.oneTimeSecret;
  if (typeof challengeId !== "string" || typeof oneTimeSecret !== "string") {
    throw new Error("enrollment challenge fields");
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const enrollBody = jsonBody({
    schemaVersion: 1,
    challengeId,
    oneTimeSecret,
    runnerId,
    publicKeySpki: encodePem("PUBLIC KEY", spki),
    certificateSigningRequestPem: createCsrPem({
      subject: runnerId,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
    }),
    proofOfPossession: signProofOfPossession(pair.privateKey, `enroll:${challengeId}:${runnerId}`),
    platform: "windows",
    capabilityObjectDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const enrolled = await admin.call({
    operationId: "enrollRunner",
    pathParams: { runnerId },
    body: enrollBody,
    headers: {
      "content-type": "application/json",
      "operation-id": newOperationId(),
      "content-digest": contentDigestSha256(enrollBody),
    },
  });
  expect(enrolled.status).toBe(201);
  const granted = Reflect.get(asObject(parseJson(enrolled.body), "enroll"), "grantedProjectIds");
  expect(Array.isArray(granted) && granted.includes(projectId)).toBe(true);

  const afterGrant = await admin.call({
    operationId: "getProject",
    pathParams: { projectId },
  });
  expect(afterGrant.status).toBe(200);
  const attestationBytes = Buffer.from(JSON.stringify({ kind: "trust-grant", projectId }), "utf8");
  const attestation = objectDigestFromBytes(attestationBytes);
  const stored = await broker.call({
    operationId: "putBlob",
    pathParams: { projectId, objectDigest: attestation },
    body: attestationBytes,
    headers: {
      "content-type": "application/octet-stream",
      "content-digest": contentDigestSha256(attestationBytes),
    },
  });
  expect([201, 204]).toContain(stored.status);
  const workspace = await broker.call({
    operationId: "createWorkspace",
    pathParams: { projectId },
    body: jsonBody({
      schemaVersion: 1,
      workspaceId,
      runnerId,
      rootFingerprint: createHash("sha256").update(workspaceId, "utf8").digest("hex"),
      platform: "windows",
      brokerAttestationObjectDigest: attestation,
      approvalId: newApprovalId(),
    }),
    headers: {
      "content-type": "application/json",
      "if-match": afterGrant.headers.etag ?? "",
    },
  });
  expect([201, 409]).toContain(workspace.status);
});
