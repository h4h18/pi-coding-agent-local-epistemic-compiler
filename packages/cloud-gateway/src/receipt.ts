import { canonicalizeRfc8785, type CloudCompletionReceipt, type ObjectDigest } from "@pi-hec/contracts";
import { unsignedEnvelope } from "./request.js";

export type ReceiptFsyncPort = {
  fsync(bytes: Uint8Array): Promise<ObjectDigest>;
};

export type CloudCallCompletionPort = {
  complete(responseDigest: ObjectDigest): Promise<void> | void;
};

export function receiptEnvelopeBytes(receipt: CloudCompletionReceipt): Uint8Array {
  return Buffer.from(
    canonicalizeRfc8785(JSON.parse(JSON.stringify(unsignedEnvelope("CloudCompletionReceipt", receipt)))),
    "utf8",
  );
}

export async function fsyncReceiptThenComplete(input: {
  receipt: CloudCompletionReceipt;
  cas: ReceiptFsyncPort;
  complete: CloudCallCompletionPort;
}): Promise<ObjectDigest> {
  const digest = await input.cas.fsync(receiptEnvelopeBytes(input.receipt));
  await input.complete.complete(digest);
  return digest;
}
