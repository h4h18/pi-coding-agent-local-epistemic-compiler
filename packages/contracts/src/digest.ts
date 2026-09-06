import { createHash } from "node:crypto";
import { canonicalize, canonicalizeRfc8785 } from "./canonical.js";
import {
  type Digest,
  type DomainDigest,
  type EnvelopeSignature,
  type JsonValue,
  type ObjectDigest,
  type PayloadDigest,
} from "./ids.js";
import { isJsonObject } from "./json.js";
import { DIGEST_PROJECTION_REGISTRY, isDigestDomain } from "./generated/digest-projections.js";

export type DigestDomain = (typeof DIGEST_PROJECTION_REGISTRY)[number]["domain"];

export type DigestProjection<TPayload extends JsonValue> = {
  domain: string;
  version: number;
  payload: TPayload;
};

export class DigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DigestError";
  }
}

export function sha256Hex(bytes: Buffer | Uint8Array | string): Digest {
  const hash = createHash("sha256");
  hash.update(bytes);
  return `sha256:${hash.digest("hex")}` as Digest;
}

export function sha256Utf8(text: string): Digest {
  return sha256Hex(Buffer.from(text, "utf8"));
}

export function objectDigestFromBytes(bytes: Buffer | Uint8Array): ObjectDigest {
  return sha256Hex(bytes) as ObjectDigest;
}

export function taggedHash<TDomain extends DigestDomain>(
  domain: TDomain,
  version: number,
  payload: JsonValue,
): DomainDigest<TDomain> {
  if (!isDigestDomain(domain)) {
    throw new DigestError(`unknown digest domain ${String(domain)}`);
  }
  const entry = DIGEST_PROJECTION_REGISTRY.find((item) => item.domain === domain);
  if (entry === undefined || entry.version !== version) {
    throw new DigestError(`unknown digest projection ${domain}@${String(version)}`);
  }
  const projected = projectDigestPayload(entry, payload);
  const canonical = canonicalize({ domain, version, payload: projected });
  return sha256Utf8(canonical) as DomainDigest<TDomain>;
}

function compareUtf8(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function projectObject(
  value: JsonValue,
  includedFields: readonly string[],
  nestedIncludedFields: Readonly<Record<string, readonly string[]>> | undefined,
): { [key: string]: JsonValue } {
  if (!isJsonObject(value)) {
    throw new DigestError("digest payload must be an object");
  }
  const allowed = new Set(includedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new DigestError(`unexpected digest field ${key}`);
    }
  }
  const projected: { [key: string]: JsonValue } = {};
  for (const field of includedFields) {
    if (!Object.hasOwn(value, field)) {
      continue;
    }
    const fieldValue = value[field];
    if (fieldValue === undefined) {
      continue;
    }
    const nested = nestedIncludedFields?.[field];
    if (nested !== undefined) {
      projected[field] = projectObject(fieldValue, nested, undefined);
    } else {
      projected[field] = fieldValue;
    }
  }
  return projected;
}

function sortSnapshotRootPayload(payload: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  const sorted = { ...payload };
  if (Array.isArray(sorted.entries)) {
    sorted.entries = [...sorted.entries].sort((left, right) => {
      const leftPath = isJsonObject(left) && typeof left.path === "string" ? left.path : "";
      const rightPath = isJsonObject(right) && typeof right.path === "string" ? right.path : "";
      return compareUtf8(leftPath, rightPath);
    });
  }
  if (Array.isArray(sorted.ignoredPathDigests)) {
    sorted.ignoredPathDigests = [...sorted.ignoredPathDigests]
      .map((item) => (typeof item === "string" ? item : ""))
      .sort(compareUtf8);
  }
  if (Array.isArray(sorted.excludedPaths)) {
    sorted.excludedPaths = [...sorted.excludedPaths].sort((left, right) => {
      const leftRef = isJsonObject(left) && isJsonObject(left.path) ? left.path.value : undefined;
      const rightRef =
        isJsonObject(right) && isJsonObject(right.path) ? right.path.value : undefined;
      return compareUtf8(typeof leftRef === "string" ? leftRef : "", typeof rightRef === "string" ? rightRef : "");
    });
  }
  return sorted;
}

function projectDigestPayload(
  entry: (typeof DIGEST_PROJECTION_REGISTRY)[number],
  payload: JsonValue,
): JsonValue {
  const nested =
    "nestedIncludedFields" in entry
      ? (entry.nestedIncludedFields as Readonly<Record<string, readonly string[]>> | undefined)
      : undefined;
  const projected = projectObject(payload, entry.includedFields, nested);
  if (entry.projectIdMandatory && typeof projected.projectId !== "string") {
    throw new DigestError(`digest domain ${entry.domain} requires projectId`);
  }
  if (entry.domain === "snapshot-root") {
    return sortSnapshotRootPayload(projected);
  }
  return projected;
}

export function payloadDigest(input: {
  schemaName: string;
  schemaVersion: number;
  payload: JsonValue;
}): PayloadDigest {
  return taggedHash("artifact-payload", 1, {
    schemaName: input.schemaName,
    schemaVersion: input.schemaVersion,
    payload: input.payload,
  });
}

export function signatureInputDigest(input: {
  schemaName: string;
  schemaVersion: number;
  payloadDigest: PayloadDigest;
  keyId: string;
  algorithm: EnvelopeSignature["algorithm"];
  signedAt: string;
  signerCertificateObjectDigest: ObjectDigest;
}): DomainDigest<"artifact-signature-input"> {
  return taggedHash("artifact-signature-input", 1, {
    schemaName: input.schemaName,
    schemaVersion: input.schemaVersion,
    payloadDigest: input.payloadDigest,
    keyId: input.keyId,
    algorithm: input.algorithm,
    signedAt: input.signedAt,
    signerCertificateObjectDigest: input.signerCertificateObjectDigest,
  });
}

export function compareSignatures(left: EnvelopeSignature, right: EnvelopeSignature): number {
  if (left.keyId !== right.keyId) {
    return left.keyId < right.keyId ? -1 : 1;
  }
  if (left.algorithm !== right.algorithm) {
    return left.algorithm < right.algorithm ? -1 : 1;
  }
  if (left.signedAt !== right.signedAt) {
    return left.signedAt < right.signedAt ? -1 : 1;
  }
  return 0;
}

export function sortSignatures(signatures: readonly EnvelopeSignature[]): EnvelopeSignature[] {
  const sorted = [...signatures].sort(compareSignatures);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      compareSignatures(previous, current) === 0
    ) {
      throw new DigestError("duplicate envelope signature identity");
    }
  }
  return sorted;
}

export type UnsignedPayloadProjection = {
  schemaName: string;
  schemaVersion: number;
  payload: JsonValue;
};

export type CasObjectProjection = {
  schemaName: string;
  schemaVersion: number;
  payload: JsonValue;
  payloadDigest: PayloadDigest;
  signatures: readonly EnvelopeSignature[];
};

export type DetachedSignatureProjection = {
  schemaName: string;
  schemaVersion: number;
  payloadDigest: PayloadDigest;
  keyId: string;
  algorithm: EnvelopeSignature["algorithm"];
  signedAt: string;
  signerCertificateObjectDigest: ObjectDigest;
};

export function unsignedPayloadProjection(
  envelope: CasObjectProjection,
): UnsignedPayloadProjection {
  return {
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
  };
}

export function canonicalizeEnvelope(envelope: CasObjectProjection): string {
  const sorted: CasObjectProjection = {
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
    payloadDigest: envelope.payloadDigest,
    signatures: sortSignatures(envelope.signatures),
  };
  return canonicalize(sorted);
}

export function envelopeObjectDigest(envelope: CasObjectProjection): ObjectDigest {
  return objectDigestFromBytes(Buffer.from(canonicalizeEnvelope(envelope), "utf8"));
}

export function rfc8785Digest(value: unknown): Digest {
  return sha256Utf8(canonicalizeRfc8785(value));
}
