import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalizeRfc8785 } from "@pi-hec/contracts";

export type CapabilityPurpose =
  | "cloud-egress"
  | "command"
  | "workspace-promotion"
  | "project-trust"
  | "project-policy"
  | "workspace-registration"
  | "blob-write"
  | "lease-claim";

export type CapabilityToken = {
  schemaVersion: 1;
  tokenId: string;
  purpose: CapabilityPurpose;
  projectId: string;
  principalId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
};

export type SignedCapability = {
  token: CapabilityToken;
  mac: string;
};

function macBytes(hostKey: Uint8Array, token: CapabilityToken): Buffer {
  const canonical = canonicalizeRfc8785(token);
  return createHmac("sha256", Buffer.from(hostKey)).update(canonical).digest();
}

function macEqual(left: Buffer, right: Buffer): boolean {
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function mintCapability(input: {
  hostKey: Uint8Array;
  purpose: CapabilityPurpose;
  projectId: string;
  principalId: string;
  issuedAt: string;
  expiresAt: string;
}): SignedCapability {
  if (input.expiresAt <= input.issuedAt) {
    throw new Error("capability expiry must be after issuedAt");
  }
  const token: CapabilityToken = {
    schemaVersion: 1,
    tokenId: `cap_${randomBytes(16).toString("hex")}`,
    purpose: input.purpose,
    projectId: input.projectId,
    principalId: input.principalId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    nonce: randomBytes(32).toString("base64url"),
  };
  return { token, mac: macBytes(input.hostKey, token).toString("base64") };
}

export type CapabilityVerifyResult =
  | { ok: true; token: CapabilityToken }
  | { ok: false; reason: "mac" | "expired" | "purpose" | "project" | "principal" };

export function verifyCapability(input: {
  hostKey: Uint8Array;
  signed: SignedCapability;
  now: string;
  purpose: CapabilityPurpose;
  projectId: string;
  principalId: string;
}): CapabilityVerifyResult {
  const expected = macBytes(input.hostKey, input.signed.token);
  const provided = Buffer.from(input.signed.mac, "base64");
  if (!macEqual(expected, provided)) {
    return { ok: false, reason: "mac" };
  }
  if (input.now > input.signed.token.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (input.signed.token.purpose !== input.purpose) {
    return { ok: false, reason: "purpose" };
  }
  if (input.signed.token.projectId !== input.projectId) {
    return { ok: false, reason: "project" };
  }
  if (input.signed.token.principalId !== input.principalId) {
    return { ok: false, reason: "principal" };
  }
  return { ok: true, token: input.signed.token };
}
