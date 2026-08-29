import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import {
  NonceCache,
  contentDigestSha256,
  generateNonce,
  mutationHeaders,
  signMutation,
  verifyMutation,
} from "../src/index.js";

test("RFC 9421 ed25519 round-trip and consumed nonce fail-closed", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const body = Buffer.from('{"schemaVersion":1}', "utf8");
  const issuedAt = "2026-08-28T00:00:00.000Z";
  const expiresAt = "2026-08-28T00:01:00.000Z";
  const nonce = generateNonce();
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const headers = mutationHeaders({
    contentType: "application/json",
    body,
    operationId: "op_01900000-0000-7000-8000-000000000001",
    issuedAt,
    expiresAt,
    nonce,
  });
  const message = {
    method: "POST",
    authority: "127.0.0.1:9443",
    targetUri: "https://127.0.0.1:9443/v1/projects",
    headers,
    body,
  };
  const signed = signMutation({
    message: { ...message, headers: { ...headers } },
    privateKey,
    keyid: "admin-1",
    alg: "ed25519",
    created: Date.parse(issuedAt) / 1000,
    expires: Date.parse(expiresAt) / 1000,
    nonce,
  });
  const withSig = {
    ...message,
    headers: {
      ...headers,
      "signature-input": signed.signatureInput,
      signature: signed.signature,
    },
  };
  const verified = verifyMutation({
    message: withSig,
    publicKey,
    nowSeconds: Date.parse(issuedAt) / 1000,
    expectedKeyId: "admin-1",
  });
  expect(verified.ok).toBe(true);
  expect(contentDigestSha256(body)).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/);

  const cache = new NonceCache(() => Date.parse(issuedAt));
  expect(
    cache.reserve({
      principalId: "admin-1",
      keyId: "admin-1",
      nonce,
      operationId: "op_01900000-0000-7000-8000-000000000001",
      expiresAtMs: Date.parse(expiresAt),
    }),
  ).toBe("reserved");
  expect(
    cache.reserve({
      principalId: "admin-1",
      keyId: "admin-1",
      nonce,
      operationId: "op_01900000-0000-7000-8000-000000000001",
      expiresAtMs: Date.parse(expiresAt),
    }),
  ).toBe("same-operation");
  expect(
    cache.reserve({
      principalId: "admin-1",
      keyId: "admin-1",
      nonce,
      operationId: "op_01900000-0000-7000-8000-000000000002",
      expiresAtMs: Date.parse(expiresAt),
    }),
  ).toBe("conflict");

  const tampered = {
    ...withSig,
    body: Buffer.from('{"schemaVersion":2}', "utf8"),
  };
  expect(
    verifyMutation({
      message: tampered,
      publicKey,
      nowSeconds: Date.parse(issuedAt) / 1000,
      expectedKeyId: "admin-1",
    }).ok,
  ).toBe(false);
});
