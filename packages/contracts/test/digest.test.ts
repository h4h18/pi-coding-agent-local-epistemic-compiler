import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  DigestError,
  envelopeObjectDigest,
  payloadDigest,
  signatureInputDigest,
  taggedHash,
} from "../src/digest.js";
import {
  type EnvelopeSignature,
  type JsonValue,
  type ObjectDigest,
  type PayloadDigest,
} from "../src/ids.js";

const ZERO_DIGEST = ("sha256:" + "00".repeat(32)) as ObjectDigest;
const payload = { hello: "world", n: 1 } satisfies JsonValue;
const goldenDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "golden");

test("taggedHash rejects domains outside the revision 1 registry", () => {
  expect(() => taggedHash("not-a-domain" as never, 1, payload)).toThrow(DigestError);
});

test("payloadDigest excludes signatures and is stable under signature reorder", () => {
  const digest = payloadDigest({ schemaName: "TaskEnvelope", schemaVersion: 1, payload });
  expect(digest.startsWith("sha256:")).toBe(true);
  expect(digest).toHaveLength(71);
  const first: EnvelopeSignature = {
    keyId: "k-b",
    algorithm: "Ed25519",
    signedAt: "2026-01-02T03:04:05.006Z",
    signerCertificateObjectDigest: ZERO_DIGEST,
    signature: "AAAA",
  };
  const second: EnvelopeSignature = {
    keyId: "k-a",
    algorithm: "Ed25519",
    signedAt: "2026-01-02T03:04:05.006Z",
    signerCertificateObjectDigest: ZERO_DIGEST,
    signature: "BBBB",
  };
  const left = envelopeObjectDigest({
    schemaName: "TaskEnvelope",
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [first, second],
  });
  const right = envelopeObjectDigest({
    schemaName: "TaskEnvelope",
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [second, first],
  });
  expect(left).toBe(right);
  const extra = envelopeObjectDigest({
    schemaName: "TaskEnvelope",
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [first],
  });
  expect(extra).not.toBe(left);
  expect(payloadDigest({ schemaName: "TaskEnvelope", schemaVersion: 1, payload })).toBe(digest);
});

test("signature input uses the dedicated domain", () => {
  const payloadHash = payloadDigest({ schemaName: "TaskEnvelope", schemaVersion: 1, payload });
  const input = signatureInputDigest({
    schemaName: "TaskEnvelope",
    schemaVersion: 1,
    payloadDigest: payloadHash,
    keyId: "k-a",
    algorithm: "Ed25519",
    signedAt: "2026-01-02T03:04:05.006Z",
    signerCertificateObjectDigest: ZERO_DIGEST,
  });
  expect(input.startsWith("sha256:")).toBe(true);
});

test("shared payload digest golden matches TypeScript taggedHash", () => {
  const golden = JSON.parse(readFileSync(path.join(goldenDir, "payload-digest.json"), "utf8")) as {
    schemaName: string;
    schemaVersion: number;
    payload: JsonValue;
    digest: string;
  };
  expect(
    payloadDigest({
      schemaName: golden.schemaName,
      schemaVersion: golden.schemaVersion,
      payload: golden.payload,
    }),
  ).toBe(golden.digest);
});

test("shared envelope object digest golden is stable", () => {
  const golden = JSON.parse(
    readFileSync(path.join(goldenDir, "envelope-object-digest.json"), "utf8"),
  ) as {
    envelope: {
      schemaName: string;
      schemaVersion: number;
      payload: JsonValue;
      payloadDigest: string;
      signatures: EnvelopeSignature[];
    };
    digest: string;
  };
  expect(
    envelopeObjectDigest({
      ...golden.envelope,
      payloadDigest: golden.envelope.payloadDigest as PayloadDigest,
    }),
  ).toBe(golden.digest);
});

test("taggedHash projects through the registry and rejects extra fields", () => {
  expect(() =>
    taggedHash("snapshot-root", 1, {
      repositoryId: "repo1",
      workspaceId: "ws1",
      dirty: false,
      filesystem: {
        platform: "linux",
        rootChildNameComparison: "case-sensitive",
        unicodeNormalization: "NFC",
        unicodeSimpleFoldTableObjectDigest: ZERO_DIGEST,
        pathGlobDialect: "pi-hec-pathglob/v1",
        volumeIdentity: "vol-1",
      },
      entries: [],
      ignoredPathDigests: [],
      excludedPaths: [],
    }),
  ).toThrow(DigestError);
  expect(() => taggedHash("snapshot-root", 1, { extra: true })).toThrow(DigestError);
});

test("snapshot-root golden vectors cover empty trees, unicode, modes, and chunks", () => {
  const golden = JSON.parse(
    readFileSync(path.join(goldenDir, "snapshot-root-vectors.json"), "utf8"),
  ) as {
    cases: { name: string; payload: JsonValue; digest: string }[];
  };
  const names = golden.cases.map((entry) => entry.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "empty-tree",
      "non-ascii-path",
      "case-sensitive-dirs",
      "symlink-submodule",
      "executable-mode",
      "chunked-blob",
    ]),
  );
  for (const entry of golden.cases) {
    expect(taggedHash("snapshot-root", 1, entry.payload)).toBe(entry.digest);
  }
});
