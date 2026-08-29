import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { expect, test } from "vitest";
import {
  createCsrPem,
  generateTestPki,
  issueLeafCertificate,
  parseCaPrivateKey,
  parseAndVerifyCsr,
} from "../src/pki.js";
import { toFastifyUrl } from "../src/orchestration/handlers.js";

test("node:crypto accepts the generated test CA and leaf certificates", () => {
  const pki = generateTestPki();
  const ca = new X509Certificate(pki.ca.certPem);
  const server = new X509Certificate(pki.server.certPem);
  const admin = new X509Certificate(pki.admin.certPem);
  expect(ca.checkIssued(ca)).toBe(true);
  expect(server.checkIssued(ca)).toBe(true);
  expect(admin.checkIssued(ca)).toBe(true);
  expect(server.subject.includes("localhost")).toBe(true);
});

test("host CA signs a CSR into a leaf that node:crypto accepts", () => {
  const pki = generateTestPki();
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const csr = createCsrPem({ subject: "issued-runner", privateKey: pair.privateKey, publicKey: pair.publicKey });
  const parsed = parseAndVerifyCsr(csr);
  const leaf = issueLeafCertificate({
    caCertPem: pki.ca.certPem,
    caPrivateKey: parseCaPrivateKey(pki.ca.keyPem),
    spkiDer: parsed.spkiDer,
    subject: "issued-runner",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
  });
  const cert = new X509Certificate(leaf.certificatePem);
  const ca = new X509Certificate(pki.ca.certPem);
  expect(cert.checkIssued(ca)).toBe(true);
});

test("toFastifyUrl escapes static colons used by custom methods", () => {
  expect(toFastifyUrl("/v1/projects/{projectId}:set-trust")).toBe("/v1/projects/:projectId(^[^:]+)::set-trust");
  expect(toFastifyUrl("/v1/projects/{projectId}/blobs:missing")).toBe("/v1/projects/:projectId/blobs::missing");
  expect(toFastifyUrl("/v1/runner/jobs:lease")).toBe("/v1/runner/jobs::lease");
  expect(toFastifyUrl("/v1/projects/{projectId}/operations/{operationId}:heartbeat")).toBe(
    "/v1/projects/:projectId/operations/:operationId(^[^:]+)::heartbeat",
  );
  expect(toFastifyUrl("/v1/projects/{projectId}/blobs/sha256/{objectDigest}")).toBe(
    "/v1/projects/:projectId/blobs/sha256/:objectDigest",
  );
});
