import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import {
  asObjectDigest,
  envelopeObjectDigest,
  payloadDigest,
  signatureInputDigest,
} from "@pi-hec/contracts";
import type { ArtifactEnvelope, JsonValue, ObjectDigest } from "@pi-hec/contracts";

export function signArtifactEnvelope(
  schemaName: string,
  payload: JsonValue,
  privateKey: KeyObject,
  keyId: string,
  certDigest: ObjectDigest,
  signedAt: string,
): ArtifactEnvelope<JsonValue> {
  const digest = payloadDigest({ schemaName, schemaVersion: 1, payload });
  const input = signatureInputDigest({
    schemaName,
    schemaVersion: 1,
    payloadDigest: digest,
    keyId,
    algorithm: "Ed25519",
    signedAt,
    signerCertificateObjectDigest: certDigest,
  });
  const signatureBytes = cryptoSign(null, Buffer.from(input, "utf8"), privateKey);
  return {
    schemaName,
    schemaVersion: 1,
    payload,
    payloadDigest: digest,
    signatures: [
      {
        keyId,
        algorithm: "Ed25519",
        signedAt,
        signerCertificateObjectDigest: certDigest,
        signature: signatureBytes.toString("base64"),
      },
    ],
  };
}

export function verifyArtifactEnvelope(
  envelope: ArtifactEnvelope<JsonValue>,
  publicKey: KeyObject,
): boolean {
  const expected = payloadDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
  });
  if (expected !== envelope.payloadDigest) {
    return false;
  }
  for (const signature of envelope.signatures) {
    const input = signatureInputDigest({
      schemaName: envelope.schemaName,
      schemaVersion: envelope.schemaVersion,
      payloadDigest: envelope.payloadDigest,
      keyId: signature.keyId,
      algorithm: signature.algorithm,
      signedAt: signature.signedAt,
      signerCertificateObjectDigest: asObjectDigest(signature.signerCertificateObjectDigest),
    });
    const ok = cryptoVerify(
      null,
      Buffer.from(input, "utf8"),
      publicKey,
      Buffer.from(signature.signature, "base64"),
    );
    if (!ok) {
      return false;
    }
  }
  return envelope.signatures.length > 0;
}

export function envelopeDigest(envelope: ArtifactEnvelope<JsonValue>): ObjectDigest {
  return envelopeObjectDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: envelope.payload,
    payloadDigest: envelope.payloadDigest,
    signatures: envelope.signatures,
  });
}
