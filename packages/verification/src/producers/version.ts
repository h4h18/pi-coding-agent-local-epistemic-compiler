import { objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";
import { toJsonValue } from "../plan/envelope.js";

export function producerVersionDigest(id: string, revision: string): ObjectDigest {
  return objectDigestFromBytes(
    Buffer.from(JSON.stringify(toJsonValue({ id, revision, schemaVersion: 1 })), "utf8"),
  );
}
