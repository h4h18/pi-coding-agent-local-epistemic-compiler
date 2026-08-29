import { type EnvelopeSignature } from "./ids.js";
import { assertKnownSchemaRevision } from "./generated/schema-registry.js";
import { isAuthoritySchema } from "./generated/signer-registry.js";
import { payloadDigest } from "./digest.js";
import { type JsonValue } from "./ids.js";

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

export function assertByteRange(start: number, end: number): void {
  if (!(start >= 0 && start < end)) {
    throw new InvariantError("byte range must satisfy 0 <= start < end");
  }
}

export function assertLineRange(start: number, end: number): void {
  if (!(start >= 1 && start <= end)) {
    throw new InvariantError("line range must satisfy 1 <= start <= end");
  }
}

export function assertEnvelopePayloadDigest(input: {
  schemaName: string;
  schemaVersion: number;
  payload: JsonValue;
  payloadDigest: string;
  signatures: readonly EnvelopeSignature[];
}): void {
  assertKnownSchemaRevision(input.schemaName, input.schemaVersion);
  if (!isAuthoritySchema(input.schemaName)) {
    throw new InvariantError(`schema ${input.schemaName} is omitted from the signer registry`);
  }
  const computed = payloadDigest({
    schemaName: input.schemaName,
    schemaVersion: input.schemaVersion,
    payload: input.payload,
  });
  if (computed !== input.payloadDigest) {
    throw new InvariantError("payloadDigest does not match unsigned payload projection");
  }
}

export function assertNever(value: never): never {
  throw new InvariantError(`unexpected variant ${JSON.stringify(value)}`);
}
