import { Compile } from "typebox/compile";
import {
  canonicalize,
  SecretInjectionGrantSchema,
  type SecretInjectionGrant,
} from "@pi-hec/contracts";
import { envelopePayload, verifyEnvelopeSignature } from "@pi-hec/sandbox";
import type { KeyObject } from "node:crypto";

const grantValidator = Compile(SecretInjectionGrantSchema);

export type GrantExpected = {
  targetRunnerId: string;
  targetProcessDigest: string;
  projectId: string;
  runId: string;
  operationId: string;
  destination: SecretInjectionGrant["destination"];
  permittedNetworkDestinations: readonly string[];
};

export type GrantVerifyResult =
  { ok: true; grant: SecretInjectionGrant } | { ok: false; reason: string };

function sameDestinations(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

function sameDestination(
  left: SecretInjectionGrant["destination"],
  right: SecretInjectionGrant["destination"],
): boolean {
  return canonicalize(left) === canonicalize(right);
}

export function verifyGrant(input: {
  envelope: unknown;
  now: string;
  capabilityAuthorityPublicKey: KeyObject;
  consumedNonces: Set<string>;
  expected: GrantExpected;
}): GrantVerifyResult {
  const payload = envelopePayload(input.envelope);
  if (!grantValidator.Check(payload)) {
    return { ok: false, reason: "extra-properties" };
  }
  if (!verifyEnvelopeSignature(input.envelope, input.capabilityAuthorityPublicKey)) {
    return { ok: false, reason: "signature-invalid" };
  }
  const grant = payload;
  if (input.consumedNonces.has(grant.nonce)) {
    return { ok: false, reason: "nonce-replay" };
  }
  if (
    input.now < grant.issuedAt ||
    input.now > grant.expiresAt ||
    grant.expiresAt <= grant.issuedAt
  ) {
    return { ok: false, reason: "expired" };
  }
  if (grant.targetRunnerId !== input.expected.targetRunnerId) {
    return { ok: false, reason: "attestation-mismatch" };
  }
  if (grant.targetProcessDigest !== input.expected.targetProcessDigest) {
    return { ok: false, reason: "attestation-mismatch" };
  }
  if (
    grant.projectId !== input.expected.projectId ||
    grant.runId !== input.expected.runId ||
    grant.operationId !== input.expected.operationId
  ) {
    return { ok: false, reason: "attestation-mismatch" };
  }
  if (!sameDestination(grant.destination, input.expected.destination)) {
    return { ok: false, reason: "destination-mismatch" };
  }
  if (
    !sameDestinations(
      grant.permittedNetworkDestinations,
      input.expected.permittedNetworkDestinations,
    )
  ) {
    return { ok: false, reason: "network-mismatch" };
  }
  input.consumedNonces.add(grant.nonce);
  return { ok: true, grant };
}
