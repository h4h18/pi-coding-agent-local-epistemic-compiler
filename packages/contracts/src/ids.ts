import { randomBytes } from "node:crypto";
import { Type, type Static, type TSchema } from "typebox";

export const SHA256_HEX_PATTERN = "^sha256:[0-9a-f]{64}$";
export const UUID_V7_BODY_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const CROCKFORD_32_PATTERN = "[a-z2-7]{52}";
export const PROJECT_ID_PATTERN = "^[a-z0-9][a-z0-9._-]*$";
export const TIMESTAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
export const MONEY_PATTERN = "^(0|[1-9][0-9]*)(\\.[0-9]{1,18})?$";
export const BASE64_PATTERN = "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$";
export const BASE64URL_UNPADDED_PATTERN = "^[A-Za-z0-9_-]+$";

export const SAFE_INTEGER_MAX = 9007199254740991;
export const ID_MAX_UTF8_BYTES = 256;
export const REASON_MAX_UTF8_BYTES = 16384;
export const TASK_TEXT_MAX_UTF8_BYTES = 262144;
export const PATH_MAX_UTF8_BYTES = 32767;
export const PATH_SEGMENT_MAX_UTF8_BYTES = 1024;
export const PROJECT_ID_MAX_UTF8_BYTES = 128;

declare const sha256Brand: unique symbol;
declare const objectDigestBrand: unique symbol;
declare const domainDigestBrand: unique symbol;
export const authenticatedScopeBrand: unique symbol = Symbol("pi-hec.authenticatedScope");
export const authenticatedScopeBrandKey = authenticatedScopeBrand;

export type Digest = `sha256:${string}` & {
  readonly [sha256Brand]: true;
};
export type ObjectDigest = Digest & {
  readonly [objectDigestBrand]: true;
};
export type DomainDigest<TDomain extends string> = Digest & {
  readonly [domainDigestBrand]: TDomain;
};
export type PayloadDigest = DomainDigest<"artifact-payload">;

export type RunId = `run_${string}`;
export type OperationId = `op_${string}`;
export type SnapshotId = `snap_${string}`;
export type CloudCallId = `call_${string}`;
export type EvidenceId = `evidence_${string}`;
export type RequirementId = `req_${string}`;
export type ObligationId = `obl_${string}`;
export type CandidateId = `candidate_${string}`;
export type CheckId = `check_${string}`;
export type ApprovalId = `approval_${string}`;
export type SchemaVersion = number;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function closed<Properties extends Parameters<typeof Type.Object>[0]>(
  properties: Properties,
): ReturnType<typeof Type.Object<Properties>> {
  return Type.Object(properties, { additionalProperties: false });
}

export function utf8BoundedString(
  maxBytes: number,
  extra: { minLength?: number; pattern?: string } = {},
) {
  const minLength = extra.minLength ?? 1;
  return Type.Refine(
    Type.String({
      minLength,
      maxLength: maxBytes,
      ...(extra.pattern === undefined ? {} : { pattern: extra.pattern }),
    }),
    (value) => utf8ByteLength(value) <= maxBytes,
    () => `string exceeds ${String(maxBytes)} UTF-8 bytes`,
  );
}

function isNfc(value: string): boolean {
  return value.normalize("NFC") === value;
}

export function parseUuidV7Bytes(body: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body)) {
    return undefined;
  }
  const hex = body.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    const slice = hex.slice(index * 2, index * 2 + 2);
    bytes[index] = Number.parseInt(slice, 16);
  }
  const version = (bytes[6] ?? 0) >> 4;
  const variant = (bytes[8] ?? 0) >> 6;
  if (version !== 7 || variant !== 2) {
    return undefined;
  }
  const reconstructed = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
  if (reconstructed !== body) {
    return undefined;
  }
  return bytes;
}

export function isPrefixedUuidV7(prefix: string, value: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  return parseUuidV7Bytes(value.slice(prefix.length)) !== undefined;
}

export function uuidV7Body(nowMs: number, rand: Uint8Array): string {
  if (rand.byteLength < 10) {
    throw new Error("uuid v7 rand must be 10 bytes");
  }
  const bytes = new Uint8Array(16);
  const ms = BigInt(nowMs);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = ((rand[0] ?? 0) & 0x0f) | 0x70;
  bytes[7] = rand[1] ?? 0;
  bytes[8] = ((rand[2] ?? 0) & 0x3f) | 0x80;
  bytes.set(rand.subarray(3, 10), 9);
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function randomPrefixedUuidV7(prefix: string): string {
  return `${prefix}${uuidV7Body(Date.now(), randomBytes(10))}`;
}

const SHA256_HEX_REGEXP = new RegExp(SHA256_HEX_PATTERN, "u");
const CROCKFORD_32_REGEXP = new RegExp(`^${CROCKFORD_32_PATTERN}$`, "u");

export class BrandError extends Error {
  readonly brand: string;
  readonly value: string;

  constructor(brand: string, value: string) {
    super(`invalid ${brand}: ${JSON.stringify(value)}`);
    this.name = "BrandError";
    this.brand = brand;
    this.value = value;
  }
}

function isPrefixedCrockford32(prefix: string, value: string): boolean {
  return value.startsWith(prefix) && CROCKFORD_32_REGEXP.test(value.slice(prefix.length));
}

export function isDigest(value: string): value is Digest {
  return SHA256_HEX_REGEXP.test(value);
}

export function isObjectDigest(value: string): value is ObjectDigest {
  return isDigest(value);
}

export function isPayloadDigest(value: string): value is PayloadDigest {
  return isDigest(value);
}

export function isRunId(value: string): value is RunId {
  return isPrefixedUuidV7("run_", value);
}

export function isOperationId(value: string): value is OperationId {
  return isPrefixedUuidV7("op_", value);
}

export function isSnapshotId(value: string): value is SnapshotId {
  return isPrefixedUuidV7("snap_", value);
}

export function isCloudCallId(value: string): value is CloudCallId {
  return isPrefixedUuidV7("call_", value);
}

export function isCandidateId(value: string): value is CandidateId {
  return isPrefixedUuidV7("candidate_", value);
}

export function isApprovalId(value: string): value is ApprovalId {
  return isPrefixedUuidV7("approval_", value);
}

export function isEvidenceId(value: string): value is EvidenceId {
  return isPrefixedCrockford32("evidence_", value);
}

export function isRequirementId(value: string): value is RequirementId {
  return isPrefixedCrockford32("req_", value);
}

export function isObligationId(value: string): value is ObligationId {
  return isPrefixedCrockford32("obl_", value);
}

export function isCheckId(value: string): value is CheckId {
  return isPrefixedCrockford32("check_", value);
}

function branded<TBrand extends string>(
  brand: string,
  guard: (value: string) => value is TBrand,
): (value: string) => TBrand {
  return (value: string): TBrand => {
    if (!guard(value)) {
      throw new BrandError(brand, value);
    }
    return value;
  };
}

export const asDigest: (value: string) => Digest = branded("digest", isDigest);
export const asObjectDigest: (value: string) => ObjectDigest = branded(
  "object digest",
  isObjectDigest,
);
export const asPayloadDigest: (value: string) => PayloadDigest = branded(
  "payload digest",
  isPayloadDigest,
);
export const asRunId: (value: string) => RunId = branded("run id", isRunId);
export const asOperationId: (value: string) => OperationId = branded("operation id", isOperationId);
export const asSnapshotId: (value: string) => SnapshotId = branded("snapshot id", isSnapshotId);
export const asCloudCallId: (value: string) => CloudCallId = branded(
  "cloud call id",
  isCloudCallId,
);
export const asCandidateId: (value: string) => CandidateId = branded("candidate id", isCandidateId);
export const asApprovalId: (value: string) => ApprovalId = branded("approval id", isApprovalId);
export const asEvidenceId: (value: string) => EvidenceId = branded("evidence id", isEvidenceId);
export const asRequirementId: (value: string) => RequirementId = branded(
  "requirement id",
  isRequirementId,
);
export const asObligationId: (value: string) => ObligationId = branded(
  "obligation id",
  isObligationId,
);
export const asCheckId: (value: string) => CheckId = branded("check id", isCheckId);

export function asEvidenceIds(values: readonly string[]): EvidenceId[] {
  return values.map(asEvidenceId);
}

function prefixedUuidSchema(prefix: string, pattern: string) {
  return Type.Refine(
    Type.String({ pattern }),
    (value) => isPrefixedUuidV7(prefix, value),
    () => `${prefix} id must be canonical lowercase UUID v7`,
  );
}

function crockfordSchema(prefix: string, pattern: string) {
  return Type.String({ pattern, minLength: prefix.length + 52, maxLength: prefix.length + 52 });
}

export const DigestSchema = Type.String({ pattern: SHA256_HEX_PATTERN });
export const ObjectDigestSchema = DigestSchema;
export const PayloadDigestSchema = DigestSchema;
export const DomainDigestSchema = DigestSchema;

export const RunIdSchema = prefixedUuidSchema("run_", `^run_${UUID_V7_BODY_PATTERN}$`);
export const OperationIdSchema = prefixedUuidSchema("op_", `^op_${UUID_V7_BODY_PATTERN}$`);
export const SnapshotIdSchema = prefixedUuidSchema("snap_", `^snap_${UUID_V7_BODY_PATTERN}$`);
export const CloudCallIdSchema = prefixedUuidSchema("call_", `^call_${UUID_V7_BODY_PATTERN}$`);
export const CandidateIdSchema = prefixedUuidSchema(
  "candidate_",
  `^candidate_${UUID_V7_BODY_PATTERN}$`,
);
export const ApprovalIdSchema = prefixedUuidSchema(
  "approval_",
  `^approval_${UUID_V7_BODY_PATTERN}$`,
);

export const EvidenceIdSchema = crockfordSchema("evidence_", `^evidence_${CROCKFORD_32_PATTERN}$`);
export const RequirementIdSchema = crockfordSchema("req_", `^req_${CROCKFORD_32_PATTERN}$`);
export const ObligationIdSchema = crockfordSchema("obl_", `^obl_${CROCKFORD_32_PATTERN}$`);
export const CheckIdSchema = crockfordSchema("check_", `^check_${CROCKFORD_32_PATTERN}$`);

export const SchemaVersionSchema = Type.Integer({ minimum: 1, maximum: SAFE_INTEGER_MAX });

export const SafeUintSchema = Type.Integer({ minimum: 0, maximum: SAFE_INTEGER_MAX });
export const PositiveSafeUintSchema = Type.Integer({ minimum: 1, maximum: SAFE_INTEGER_MAX });
export const ConfidenceSchema = Type.Number({ minimum: 0, maximum: 1 });
export const MoneySchema = Type.String({ pattern: MONEY_PATTERN });

export const TimestampSchema = Type.Refine(
  Type.String({ pattern: TIMESTAMP_PATTERN }),
  (value) => {
    if (value.endsWith("60.000Z") || value.slice(17, 19) === "60") {
      return false;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return new Date(parsed).toISOString() === value;
  },
  () => "timestamp must be canonical UTC YYYY-MM-DDTHH:mm:ss.SSSZ",
);

export const ProjectIdSchema = Type.Refine(
  Type.String({ pattern: PROJECT_ID_PATTERN, minLength: 1, maxLength: PROJECT_ID_MAX_UTF8_BYTES }),
  (value) => isNfc(value) && utf8ByteLength(value) <= PROJECT_ID_MAX_UTF8_BYTES,
  () => "project/workspace/runner ids must be NFC and 1-128 UTF-8 bytes",
);

export const NormalizedPathSchema = Type.Refine(
  Type.String({ minLength: 1, maxLength: PATH_MAX_UTF8_BYTES }),
  (value) => {
    if (!isNfc(value) || utf8ByteLength(value) > PATH_MAX_UTF8_BYTES) {
      return false;
    }
    if (value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
      return false;
    }
    const segments = value.split("/");
    return segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        utf8ByteLength(segment) <= PATH_SEGMENT_MAX_UTF8_BYTES,
    );
  },
  () => "path must be NFC, /-separated, repository-relative",
);

export const ReasonSchema = utf8BoundedString(REASON_MAX_UTF8_BYTES);
export const TaskTextSchema = utf8BoundedString(TASK_TEXT_MAX_UTF8_BYTES);
export const GeneralIdSchema = utf8BoundedString(ID_MAX_UTF8_BYTES);

export const Base64Schema = Type.Refine(
  Type.String({ pattern: BASE64_PATTERN }),
  (value) => {
    if (value.length % 4 !== 0) {
      return false;
    }
    try {
      const decoded = Buffer.from(value, "base64");
      return decoded.toString("base64") === value;
    } catch {
      return false;
    }
  },
  () => "base64 must be RFC 4648 with minimal padding",
);

export const Base64UrlUnpaddedSchema = Type.Refine(
  Type.String({ pattern: BASE64URL_UNPADDED_PATTERN, minLength: 1 }),
  (value) => {
    if (value.includes("=")) {
      return false;
    }
    try {
      const padded = value.concat("=".repeat((4 - (value.length % 4)) % 4));
      const decoded = Buffer.from(padded, "base64url");
      return decoded.toString("base64url").replaceAll("=", "") === value;
    } catch {
      return false;
    }
  },
  () => "base64url must be unpadded RFC 4648 URL alphabet",
);

export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);

export type JsonValue = Static<typeof JsonValueSchema>;

export const SignatureAlgorithmSchema = Type.Enum(["Ed25519", "ECDSA-P256-SHA256"] as const);

export const EnvelopeSignatureSchema = closed({
  keyId: GeneralIdSchema,
  algorithm: SignatureAlgorithmSchema,
  signedAt: TimestampSchema,
  signerCertificateObjectDigest: ObjectDigestSchema,
  signature: Base64Schema,
});

export function ArtifactEnvelopeSchema<Payload extends TSchema>(payload: Payload) {
  return closed({
    schemaName: GeneralIdSchema,
    schemaVersion: SchemaVersionSchema,
    payload,
    payloadDigest: PayloadDigestSchema,
    signatures: Type.Array(EnvelopeSignatureSchema, { maxItems: 16 }),
  });
}

export type EnvelopeSignature = Static<typeof EnvelopeSignatureSchema>;
export type ArtifactEnvelope<TPayload> = {
  schemaName: string;
  schemaVersion: SchemaVersion;
  payload: TPayload;
  payloadDigest: PayloadDigest;
  signatures: EnvelopeSignature[];
};

export type DigestSchemaType = Static<typeof DigestSchema>;
export type RunIdSchemaType = Static<typeof RunIdSchema>;
export type OperationIdSchemaType = Static<typeof OperationIdSchema>;
export type SnapshotIdSchemaType = Static<typeof SnapshotIdSchema>;
export type CloudCallIdSchemaType = Static<typeof CloudCallIdSchema>;
export type CandidateIdSchemaType = Static<typeof CandidateIdSchema>;
export type ApprovalIdSchemaType = Static<typeof ApprovalIdSchema>;
export type EvidenceIdSchemaType = Static<typeof EvidenceIdSchema>;
export type RequirementIdSchemaType = Static<typeof RequirementIdSchema>;
export type ObligationIdSchemaType = Static<typeof ObligationIdSchema>;
export type CheckIdSchemaType = Static<typeof CheckIdSchema>;
