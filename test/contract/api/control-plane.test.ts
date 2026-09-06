import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ControlPlaneClient, jsonBody, type MutationSigner } from "../../../packages/client/src/index.ts";
import { constructPrincipalScope, contentDigestSha256 } from "../../../packages/security/src/index.ts";
import {
  createCsrPem,
  pem,
  signProofOfPossession,
} from "../../../apps/control-plane/src/pki.ts";
import {
  PROJECT_ID,
  RUN_ID,
  RUNNER_ID,
  approvalId,
  createProjectBody,
  digestOf,
  makeSigner,
  opId,
  parseJson,
  policyEnvelope,
  startHarness,
  type Harness,
} from "../../../apps/control-plane/test/harness.ts";

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

function h(): Harness {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return harness;
}

function errorCode(body: Buffer): string {
  const parsed = parseJson(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("code" in parsed)) {
    return "";
  }
  const code: unknown = Reflect.get(parsed, "code");
  return typeof code === "string" ? code : "";
}

test("unauthenticated and wrong-audience never emit 403", async () => {
  const unauth = await h().unknown.call({
    operationId: "getProject",
    pathParams: { projectId: PROJECT_ID },
  });
  expect(unauth.status).toBe(401);
  expect(unauth.status).not.toBe(403);
  const workerCreate = await h().worker.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody("proj-forbidden")),
    headers: { "content-type": "application/json", "operation-id": opId(1) },
  });
  expect(workerCreate.status).toBe(404);
  expect(workerCreate.status).not.toBe(403);
  const missing = await h().broker.call({
    operationId: "getProject",
    pathParams: { projectId: "proj-missing" },
  });
  expect(missing.status).toBe(404);
  expect(missing.status).not.toBe(403);
});

test("idempotent mutation replays byte-exact and conflicting operation id is 409", async () => {
  const body = jsonBody(createProjectBody("proj-idem"));
  const headers = { "content-type": "application/json", "operation-id": opId(2) };
  let frozen: Record<string, string> | undefined;
  const replaySigner: MutationSigner = (input) => {
    const signed = makeSigner(h().adminPrivateKey, "admin-1", h().clock)(input);
    frozen ??= signed.headers;
    return { headers: frozen };
  };
  const client = new ControlPlaneClient({
    baseUrl: h().listening.mtlsUrl,
    enrollBaseUrl: h().listening.enrollUrl,
    tls: {
      ca: h().pki.ca.certPem,
      cert: h().pki.admin.certPem,
      key: h().pki.admin.keyPem,
      servername: "127.0.0.1",
    },
    signer: replaySigner,
  });
  const first = await client.call({ operationId: "createProject", body, headers });
  expect(first.status).toBe(201);
  const second = await client.call({ operationId: "createProject", body, headers });
  expect(second.status).toBe(first.status);
  expect(second.body.equals(first.body)).toBe(true);
  expect(second.headers["operation-id"]).toBe(opId(2));
  client.close();
  const conflict = await h().admin.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody("proj-idem-other")),
    headers: { "content-type": "application/json", "operation-id": opId(2) },
  });
  expect(conflict.status).toBe(409);
  expect(errorCode(conflict.body)).toBe("OPERATION_ID_REUSED");
});

test("If-Match missing is 428 and stale is 412", async () => {
  const policy = jsonBody({
    schemaVersion: 1,
    policy: policyEnvelope(PROJECT_ID),
    approvalId: approvalId(3),
  });
  const missing = await h().admin.call({
    operationId: "updateProjectPolicy",
    pathParams: { projectId: PROJECT_ID },
    body: policy,
    headers: { "content-type": "application/json", "operation-id": opId(4) },
  });
  expect(missing.status).toBe(428);
  const stale = await h().admin.call({
    operationId: "updateProjectPolicy",
    pathParams: { projectId: PROJECT_ID },
    body: policy,
    headers: {
      "content-type": "application/json",
      "operation-id": opId(5),
      "if-match": '"999999"',
    },
  });
  expect(stale.status).toBe(412);
});

test("malformed 400, oversize 413, wrong media 415", async () => {
  const malformed = await h().admin.call({
    operationId: "createProject",
    body: Buffer.from("{not-json", "utf8"),
    headers: { "content-type": "application/json", "operation-id": opId(6) },
  });
  expect(malformed.status).toBe(400);
  const media = await h().admin.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody("proj-media")),
    headers: { "content-type": "text/plain", "operation-id": opId(7) },
  });
  expect(media.status).toBe(415);
  const hugePayload = `{"schemaVersion":1,"pad":"${"a".repeat(1_048_576)}"}`;
  const oversize = await h().admin.call({
    operationId: "createProject",
    body: Buffer.from(hugePayload, "utf8"),
    headers: { "content-type": "application/json", "operation-id": opId(8) },
  });
  expect(oversize.status).toBe(413);
  const schema = await h().admin.call({
    operationId: "createProject",
    body: jsonBody({ schemaVersion: 1 }),
    headers: { "content-type": "application/json", "operation-id": opId(9) },
  });
  expect([400, 422]).toContain(schema.status);
});

test("RFC 9421 nonce reuse under another operation fails closed", async () => {
  let frozen: Record<string, string> | undefined;
  const replaySigner: MutationSigner = (input) => {
    const signed = makeSigner(h().adminPrivateKey, "admin-1", h().clock)(input);
    frozen ??= signed.headers;
    return { headers: frozen };
  };
  const client = new ControlPlaneClient({
    baseUrl: h().listening.mtlsUrl,
    enrollBaseUrl: h().listening.enrollUrl,
    tls: {
      ca: h().pki.ca.certPem,
      cert: h().pki.admin.certPem,
      key: h().pki.admin.keyPem,
      servername: "127.0.0.1",
    },
    signer: replaySigner,
  });
  const first = await client.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody("proj-nonce-a")),
    headers: { "content-type": "application/json", "operation-id": opId(10) },
  });
  expect(first.status).toBe(201);
  const reused = await client.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody("proj-nonce-b")),
    headers: { "content-type": "application/json", "operation-id": opId(11) },
  });
  expect(reused.status).toBe(401);
  client.close();
});

test("concurrent If-Match: one wins and the other is 412", async () => {
  const current = await h().admin.call({
    operationId: "getProject",
    pathParams: { projectId: PROJECT_ID },
  });
  expect(current.status).toBe(200);
  const etag = current.headers.etag;
  expect(typeof etag).toBe("string");
  const bodyA = jsonBody({
    schemaVersion: 1,
    policy: policyEnvelope(PROJECT_ID, ["concurrent-a"]),
    approvalId: approvalId(20),
  });
  const bodyB = jsonBody({
    schemaVersion: 1,
    policy: policyEnvelope(PROJECT_ID, ["concurrent-b"]),
    approvalId: approvalId(21),
  });
  const [left, right] = await Promise.all([
    h().admin.call({
      operationId: "updateProjectPolicy",
      pathParams: { projectId: PROJECT_ID },
      body: bodyA,
      headers: { "content-type": "application/json", "operation-id": opId(22), "if-match": etag ?? "" },
    }),
    h().admin.call({
      operationId: "updateProjectPolicy",
      pathParams: { projectId: PROJECT_ID },
      body: bodyB,
      headers: { "content-type": "application/json", "operation-id": opId(23), "if-match": etag ?? "" },
    }),
  ]);
  const statuses = [left.status, right.status].sort();
  expect(statuses).toEqual([200, 412]);
});

test("putBlob returns 201 then identical 204; digest mismatch is 422", async () => {
  const bytes = Buffer.from("blob-bytes-for-cas", "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const headers = {
    "content-type": "application/octet-stream",
    "operation-id": opId(30),
    "content-digest": contentDigestSha256(bytes),
  };
  const created = await h().broker.call({
    operationId: "putBlob",
    pathParams: { projectId: PROJECT_ID, objectDigest: digest },
    body: bytes,
    headers,
  });
  expect(created.status).toBe(201);
  const reused = await h().broker.call({
    operationId: "putBlob",
    pathParams: { projectId: PROJECT_ID, objectDigest: digest },
    body: bytes,
    headers: { ...headers, "operation-id": opId(31) },
  });
  expect(reused.status).toBe(204);
  const mismatch = await h().broker.call({
    operationId: "putBlob",
    pathParams: {
      projectId: PROJECT_ID,
      objectDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    body: bytes,
    headers: { ...headers, "operation-id": opId(32) },
  });
  expect(mismatch.status).toBe(422);
});

test("lease heartbeat complete; expired generation cannot complete", async () => {
  const now = h().clock();
  const inputDigest = digestOf("lease-input");
  const errorDigest = digestOf("lease-error");
  const projectScope = h().store.toProjectScope(
    constructPrincipalScope({
      record: h().listening.ctx.hostAdminRecord,
      grants: [
        { projectId: PROJECT_ID, roles: ["admin"], grantObjectDigest: digestOf("host-runner-grant-policy"), revokedAt: undefined },
      ],
      authenticatedAt: now,
    }),
    PROJECT_ID,
  );
  h().store.putArtifact(projectScope, {
    digest: inputDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:lease-input",
    encryptionNonce: "0000000000000000000000aa",
    storageRecordDigest: digestOf("storage-lease-input"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  h().store.putArtifact(projectScope, {
    digest: errorDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:lease-error",
    encryptionNonce: "0000000000000000000000ab",
    storageRecordDigest: digestOf("storage-lease-error"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  const liveId = opId(40);
  h().store.enqueueOperation(projectScope, {
    operationId: liveId,
    runId: RUN_ID,
    operationKind: "APPLY_USER_INPUT",
    dedupeKey: `lease-live:${liveId}`,
    inputDigest,
    createdAt: now,
  });
  const leased = await h().runner.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      capabilitiesObjectDigest: digestOf("host-runner-capability"),
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(41) },
  });
  expect(leased.status).toBe(200);
  const leaseBody = parseJson(leased.body);
  if (leaseBody === null || typeof leaseBody !== "object" || Array.isArray(leaseBody)) {
    throw new Error("lease body");
  }
  expect(Reflect.get(leaseBody, "outcome")).toBe("LEASED");
  const token: unknown = Reflect.get(leaseBody, "leaseToken");
  const generation: unknown = Reflect.get(leaseBody, "leaseGeneration");
  const operationId: unknown = Reflect.get(leaseBody, "operationId");
  if (typeof token !== "string" || typeof generation !== "number" || typeof operationId !== "string") {
    throw new Error("lease fields");
  }
  const beat = await h().runner.call({
    operationId: "heartbeatOperation",
    pathParams: { projectId: PROJECT_ID, operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: token,
      leaseGeneration: generation,
      observedInputObjectDigest: inputDigest,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(42) },
  });
  expect(beat.status).toBe(200);
  const resultBytes = Buffer.from("lease-result", "utf8");
  const resultDigest = `sha256:${createHash("sha256").update(resultBytes).digest("hex")}`;
  const put = await h().runner.call({
    operationId: "putBlob",
    pathParams: { projectId: PROJECT_ID, objectDigest: resultDigest },
    body: resultBytes,
    headers: {
      "content-type": "application/octet-stream",
      "operation-id": opId(43),
      "content-digest": contentDigestSha256(resultBytes),
    },
  });
  expect([201, 204]).toContain(put.status);
  const done = await h().runner.call({
    operationId: "completeOperation",
    pathParams: { projectId: PROJECT_ID, operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: token,
      leaseGeneration: generation,
      outcome: "SUCCEEDED",
      resultObjectDigest: resultDigest,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(44) },
  });
  expect(done.status).toBe(200);

  const expiredId = opId(50);
  h().store.enqueueOperation(projectScope, {
    operationId: expiredId,
    runId: RUN_ID,
    operationKind: "APPLY_USER_INPUT",
    dedupeKey: `lease-expired:${expiredId}`,
    inputDigest,
    createdAt: h().clock(),
  });
  const leased2 = await h().runner.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      capabilitiesObjectDigest: digestOf("host-runner-capability"),
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(51) },
  });
  const lease2 = parseJson(leased2.body);
  if (lease2 === null || typeof lease2 !== "object" || Array.isArray(lease2)) {
    throw new Error("lease2");
  }
  const token2: unknown = Reflect.get(lease2, "leaseToken");
  const generation2: unknown = Reflect.get(lease2, "leaseGeneration");
  const operationId2: unknown = Reflect.get(lease2, "operationId");
  if (typeof token2 !== "string" || typeof generation2 !== "number" || typeof operationId2 !== "string") {
    throw new Error("lease2 fields");
  }
  h().advance(31_000);
  const expired = await h().runner.call({
    operationId: "completeOperation",
    pathParams: { projectId: PROJECT_ID, operationId: operationId2 },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: token2,
      leaseGeneration: generation2,
      outcome: "FAILED",
      errorObjectDigest: errorDigest,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(52) },
  });
  expect(expired.status).toBe(410);
});

function enrollHeaders(body: Buffer, operationId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "operation-id": operationId,
    "content-digest": contentDigestSha256(body),
  };
}

test("enroll returns parseable X.509 PEM, replays, and conflicts on a different digest", async () => {
  const challengeBody = jsonBody({
    schemaVersion: 1,
    permittedProjectIds: [PROJECT_ID],
    runnerPlatform: "windows",
    expiresInSeconds: 3600,
  });
  const challenge = await h().admin.call({
    operationId: "createRunnerEnrollmentChallenge",
    body: challengeBody,
    headers: { "content-type": "application/json", "operation-id": opId(60) },
  });
  expect(challenge.status).toBe(201);
  const challengeJson = parseJson(challenge.body);
  if (challengeJson === null || typeof challengeJson !== "object" || Array.isArray(challengeJson)) {
    throw new Error("challenge");
  }
  const challengeId: unknown = Reflect.get(challengeJson, "challengeId");
  const oneTimeSecret: unknown = Reflect.get(challengeJson, "oneTimeSecret");
  if (typeof challengeId !== "string" || typeof oneTimeSecret !== "string") {
    throw new Error("challenge fields");
  }
  expect(oneTimeSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(oneTimeSecret).not.toContain(challengeId);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const runnerId = "runner-enrolled-alpha";
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const csrPem = createCsrPem({ subject: runnerId, privateKey: pair.privateKey, publicKey: pair.publicKey });
  const proof = signProofOfPossession(pair.privateKey, `enroll:${challengeId}:${runnerId}`);
  const enrollPayload = {
    schemaVersion: 1 as const,
    challengeId,
    oneTimeSecret,
    runnerId,
    publicKeySpki: pem("PUBLIC KEY", spki),
    certificateSigningRequestPem: csrPem,
    proofOfPossession: proof,
    platform: "windows" as const,
    capabilityObjectDigest: digestOf("host-runner-capability"),
  };
  const enrollBody = jsonBody(enrollPayload);
  const first = await h().admin.call({
    operationId: "enrollRunner",
    pathParams: { runnerId },
    body: enrollBody,
    headers: enrollHeaders(enrollBody, opId(61)),
  });
  expect(first.status).toBe(201);
  expect(first.headers["operation-id"]).toBe(opId(61));
  const firstJson = parseJson(first.body);
  if (firstJson === null || typeof firstJson !== "object" || Array.isArray(firstJson)) {
    throw new Error("enroll body");
  }
  const certificatePem: unknown = Reflect.get(firstJson, "certificatePem");
  const chain: unknown = Reflect.get(firstJson, "certificateChainPem");
  const granted: unknown = Reflect.get(firstJson, "grantedProjectIds");
  if (typeof certificatePem !== "string") {
    throw new Error("certificatePem");
  }
  const leaf = new X509Certificate(certificatePem);
  const ca = new X509Certificate(h().pki.ca.certPem);
  expect(leaf.checkIssued(ca)).toBe(true);
  expect(Array.isArray(chain)).toBe(true);
  expect(Array.isArray(granted) && granted.includes(PROJECT_ID)).toBe(true);
  const replay = await h().admin.call({
    operationId: "enrollRunner",
    pathParams: { runnerId },
    body: enrollBody,
    headers: enrollHeaders(enrollBody, opId(61)),
  });
  expect(replay.status).toBe(201);
  expect(replay.body.equals(first.body)).toBe(true);
  const otherBody = jsonBody({ ...enrollPayload, platform: "linux" });
  const conflict = await h().admin.call({
    operationId: "enrollRunner",
    pathParams: { runnerId },
    body: otherBody,
    headers: enrollHeaders(otherBody, opId(61)),
  });
  expect(conflict.status).toBe(409);

  const enrolled = new ControlPlaneClient({
    baseUrl: h().listening.mtlsUrl,
    enrollBaseUrl: h().listening.enrollUrl,
    tls: {
      ca: h().pki.ca.certPem,
      cert: certificatePem,
      key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      servername: "127.0.0.1",
    },
    signer: makeSigner(pair.privateKey, `runner-${runnerId}`, h().clock, "ecdsa-p256-sha256"),
  });
  const blobs = await enrolled.call({
    operationId: "missingBlobs",
    pathParams: { projectId: PROJECT_ID },
    body: jsonBody({ schemaVersion: 1, objectDigests: [digestOf("enroll-mtls-probe")] }),
    headers: { "content-type": "application/json" },
  });
  expect(blobs.status).toBe(200);

  const rotatedPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rotateBody = jsonBody({
    schemaVersion: 1,
    publicKeySpki: pem("PUBLIC KEY", rotatedPair.publicKey.export({ type: "spki", format: "der" })),
    certificateSigningRequestPem: createCsrPem({
      subject: runnerId,
      privateKey: rotatedPair.privateKey,
      publicKey: rotatedPair.publicKey,
    }),
    proofOfPossession: signProofOfPossession(rotatedPair.privateKey, `rotate:${runnerId}`),
  });
  const rotated = await enrolled.call({
    operationId: "rotateRunnerCertificate",
    pathParams: { runnerId },
    body: rotateBody,
    headers: { "content-type": "application/json", "operation-id": opId(64) },
  });
  expect(rotated.status).toBe(201);
  const previousSerial = new X509Certificate(certificatePem).serialNumber.replaceAll(":", "").toLowerCase();
  expect(h().store.lookupRunnerCertificateBySerial(previousSerial)?.revokedAt).toBeDefined();
  const rotatedJson = parseJson(rotated.body);
  if (rotatedJson === null || typeof rotatedJson !== "object" || Array.isArray(rotatedJson)) {
    throw new Error("rotate");
  }
  const rotatedPem: unknown = Reflect.get(rotatedJson, "certificatePem");
  if (typeof rotatedPem !== "string") {
    throw new Error("rotate pem");
  }
  const afterRotateOld = await enrolled.call({
    operationId: "missingBlobs",
    pathParams: { projectId: PROJECT_ID },
    body: jsonBody({ schemaVersion: 1, objectDigests: [digestOf("enroll-mtls-probe")] }),
    headers: { "content-type": "application/json" },
  });
  expect([401, 404]).toContain(afterRotateOld.status);
  const rotatedClient = new ControlPlaneClient({
    baseUrl: h().listening.mtlsUrl,
    enrollBaseUrl: h().listening.enrollUrl,
    tls: {
      ca: h().pki.ca.certPem,
      cert: rotatedPem,
      key: rotatedPair.privateKey.export({ type: "pkcs8", format: "pem" }),
      servername: "127.0.0.1",
    },
    signer: makeSigner(rotatedPair.privateKey, `runner-${runnerId}`, h().clock, "ecdsa-p256-sha256"),
  });
  const blobsRotated = await rotatedClient.call({
    operationId: "missingBlobs",
    pathParams: { projectId: PROJECT_ID },
    body: jsonBody({ schemaVersion: 1, objectDigests: [digestOf("enroll-mtls-probe")] }),
    headers: { "content-type": "application/json" },
  });
  expect(blobsRotated.status).toBe(200);
  rotatedClient.close();

  const revoked = await h().admin.call({
    operationId: "revokeRunner",
    pathParams: { runnerId },
    body: jsonBody({
      schemaVersion: 1,
      reason: "test-revoke",
      effectiveAt: h().clock(),
    }),
    headers: { "content-type": "application/json", "operation-id": opId(62) },
  });
  expect(revoked.status).toBe(204);
  const afterRevoke = await enrolled.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId,
      capabilitiesObjectDigest: digestOf("host-runner-capability"),
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(63) },
  });
  expect([401, 404]).toContain(afterRevoke.status);
  enrolled.close();
});

test("stale If-Match on setProjectTrust is 412", async () => {
  const body = jsonBody({
    schemaVersion: 1,
    trustState: "trusted",
    approvalId: approvalId(70),
  });
  const stale = await h().admin.call({
    operationId: "setProjectTrust",
    pathParams: { projectId: PROJECT_ID },
    body,
    headers: {
      "content-type": "application/json",
      "operation-id": opId(71),
      "if-match": '"999999"',
    },
  });
  expect(stale.status).toBe(412);
  expect(stale.headers["operation-id"]).toBe(opId(71));
});

test("putBlob with no body is 422", async () => {
  const empty = await h().broker.call({
    operationId: "putBlob",
    pathParams: {
      projectId: PROJECT_ID,
      objectDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    },
    headers: {
      "content-type": "application/octet-stream",
      "operation-id": opId(72),
    },
  });
  expect(empty.status).toBe(422);
});

test("heartbeat with the wrong lease generation is rejected", async () => {
  const now = h().clock();
  const inputDigest = digestOf("hb-wrong-gen-input");
  const projectScope = h().store.toProjectScope(
    constructPrincipalScope({
      record: h().listening.ctx.hostAdminRecord,
      grants: [
        { projectId: PROJECT_ID, roles: ["admin"], grantObjectDigest: digestOf("host-runner-grant-policy"), revokedAt: undefined },
      ],
      authenticatedAt: now,
    }),
    PROJECT_ID,
  );
  h().store.putArtifact(projectScope, {
    digest: inputDigest,
    schemaName: null,
    mediaType: "application/json",
    byteSize: 8,
    classification: "internal",
    encryptionAlgorithm: "AES-256-GCM",
    encryptionKeyId: "cas:hb-wrong-gen",
    encryptionNonce: "0000000000000000000000ac",
    storageRecordDigest: digestOf("storage-hb-wrong-gen"),
    storageRecordSigningKeyId: "host-sign",
    storageRecordSignatureAlgorithm: "Ed25519",
    storageRecordSignedAt: now,
    storageRecordSignerCertificateDigest: digestOf("host-signer-cert"),
    storageRecordSignature: "c2ln",
    createdAt: now,
  });
  const liveId = opId(80);
  h().store.enqueueOperation(projectScope, {
    operationId: liveId,
    runId: RUN_ID,
    operationKind: "APPLY_USER_INPUT",
    dedupeKey: `hb-wrong:${liveId}`,
    inputDigest,
    createdAt: now,
  });
  const leased = await h().runner.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      capabilitiesObjectDigest: digestOf("host-runner-capability"),
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(81) },
  });
  expect(leased.status).toBe(200);
  const leaseBody = parseJson(leased.body);
  if (leaseBody === null || typeof leaseBody !== "object" || Array.isArray(leaseBody)) {
    throw new Error("lease body");
  }
  const token: unknown = Reflect.get(leaseBody, "leaseToken");
  const generation: unknown = Reflect.get(leaseBody, "leaseGeneration");
  const operationId: unknown = Reflect.get(leaseBody, "operationId");
  if (typeof token !== "string" || typeof generation !== "number" || typeof operationId !== "string") {
    throw new Error("lease fields");
  }
  const beat = await h().runner.call({
    operationId: "heartbeatOperation",
    pathParams: { projectId: PROJECT_ID, operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: token,
      leaseGeneration: generation + 1,
      observedInputObjectDigest: inputDigest,
    }),
    headers: { "content-type": "application/json", "operation-id": opId(82) },
  });
  expect([409, 410]).toContain(beat.status);
});

