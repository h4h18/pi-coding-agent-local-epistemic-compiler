import { sealSecretToRecipient, type SealedSecret } from "@pi-hec/sandbox";

export function sealAndZeroize(plaintext: Buffer, recipientPublicKeyRaw: Uint8Array): SealedSecret {
  const sealed = sealSecretToRecipient(plaintext, recipientPublicKeyRaw);
  plaintext.fill(0);
  return sealed;
}
