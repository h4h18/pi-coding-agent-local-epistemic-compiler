import { createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { MUTATION_SIGNATURE_COMPONENTS } from "@pi-hec/contracts";

export const MUTATION_PROFILE_TAG = "pi-hec-mutation-v1";
export const MAX_CREATED_SKEW_SECONDS = 30;
export const MAX_LIFETIME_SECONDS = 120;
export const SIGNATURE_LABEL = "sig1";

export type CoveredComponent = (typeof MUTATION_SIGNATURE_COMPONENTS)[number] | "if-match" | "content-range";

export type MutationMessage = {
  method: string;
  authority: string;
  targetUri: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
};

export type SignatureParams = {
  created: number;
  expires: number;
  nonce: string;
  keyid: string;
  alg: "ed25519" | "ecdsa-p256-sha256";
  tag: typeof MUTATION_PROFILE_TAG;
  covered: readonly CoveredComponent[];
};

export class NonceCache {
  readonly #entries = new Map<string, { operationId: string; expiresAtMs: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  sweep(): void {
    const now = this.nowMs();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= now) {
        this.#entries.delete(key);
      }
    }
  }

  reserve(input: {
    principalId: string;
    keyId: string;
    nonce: string;
    operationId: string;
    expiresAtMs: number;
  }): "reserved" | "same-operation" | "conflict" {
    this.sweep();
    const key = `${input.principalId}\0${input.keyId}\0${input.nonce}`;
    const existing = this.#entries.get(key);
    if (existing === undefined) {
      this.#entries.set(key, { operationId: input.operationId, expiresAtMs: input.expiresAtMs });
      return "reserved";
    }
    if (existing.operationId === input.operationId) {
      return "same-operation";
    }
    return "conflict";
  }
}

export function contentDigestSha256(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();
  return `sha-256=:${digest.toString("base64")}:`;
}

export function generateNonce(): string {
  return randomBytes(32).toString("base64url");
}

function sfString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sfByteSequence(bytes: Uint8Array): string {
  return `:${Buffer.from(bytes).toString("base64")}:`;
}

function headerLookup(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) {
      return value;
    }
  }
  return undefined;
}

function componentValue(message: MutationMessage, component: CoveredComponent): string {
  switch (component) {
    case "@method":
      return message.method.toUpperCase();
    case "@authority":
      return message.authority.toLowerCase();
    case "@target-uri":
      return message.targetUri;
    case "content-digest":
    case "content-type":
    case "content-length":
    case "operation-id":
    case "x-hec-issued-at":
    case "x-hec-expires-at":
    case "x-hec-nonce":
    case "if-match":
    case "content-range": {
      const value = headerLookup(message.headers, component);
      if (value === undefined) {
        throw new Error(`missing covered component ${component}`);
      }
      return value;
    }
    default: {
      const exhaustive: never = component;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function innerList(covered: readonly CoveredComponent[]): string {
  const items = covered.map((component) => sfString(component)).join(" ");
  return `(${items})`;
}

function signatureParamsInner(params: SignatureParams): string {
  return `${innerList(params.covered)};created=${String(params.created)};expires=${String(params.expires)};nonce=${sfString(params.nonce)};keyid=${sfString(params.keyid)};alg=${sfString(params.alg)};tag=${sfString(params.tag)}`;
}

export function buildSignatureBase(message: MutationMessage, params: SignatureParams): string {
  const lines = params.covered.map((component) => `${sfString(component)}: ${componentValue(message, component)}`);
  lines.push(`"@signature-params": ${signatureParamsInner(params)}`);
  return lines.join("\n");
}

export function serializeSignatureInput(params: SignatureParams): string {
  return `${SIGNATURE_LABEL}=${signatureParamsInner(params)}`;
}

export function serializeSignature(signatureBytes: Uint8Array): string {
  return `${SIGNATURE_LABEL}=${sfByteSequence(signatureBytes)}`;
}

function coveredFor(message: MutationMessage): CoveredComponent[] {
  const covered: CoveredComponent[] = [...MUTATION_SIGNATURE_COMPONENTS];
  if (headerLookup(message.headers, "if-match") !== undefined) {
    covered.push("if-match");
  }
  if (headerLookup(message.headers, "content-range") !== undefined) {
    covered.push("content-range");
  }
  return covered;
}

export function signMutation(input: {
  message: MutationMessage;
  privateKey: KeyObject;
  keyid: string;
  alg: SignatureParams["alg"];
  created: number;
  expires: number;
  nonce: string;
}): { signatureInput: string; signature: string; params: SignatureParams } {
  const params: SignatureParams = {
    created: input.created,
    expires: input.expires,
    nonce: input.nonce,
    keyid: input.keyid,
    alg: input.alg,
    tag: MUTATION_PROFILE_TAG,
    covered: coveredFor(input.message),
  };
  const base = buildSignatureBase(input.message, params);
  const signatureBytes = cryptoSign(
    input.alg === "ed25519" ? null : "sha256",
    Buffer.from(base, "utf8"),
    input.privateKey,
  );
  return {
    signatureInput: serializeSignatureInput(params),
    signature: serializeSignature(signatureBytes),
    params,
  };
}

function parseSfString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    return undefined;
  }
  return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

function parseSfByteSequence(raw: string): Buffer | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(":") || !trimmed.endsWith(":") || trimmed.length < 2) {
    return undefined;
  }
  return Buffer.from(trimmed.slice(1, -1), "base64");
}

function splitParams(inner: string): { list: string; rest: string } | undefined {
  if (!inner.startsWith("(")) {
    return undefined;
  }
  const end = inner.indexOf(")");
  if (end < 0) {
    return undefined;
  }
  return { list: inner.slice(1, end), rest: inner.slice(end + 1) };
}

export function parseSignatureInput(header: string): SignatureParams | undefined {
  const prefix = `${SIGNATURE_LABEL}=`;
  if (!header.startsWith(prefix)) {
    return undefined;
  }
  const split = splitParams(header.slice(prefix.length));
  if (split === undefined) {
    return undefined;
  }
  const covered: CoveredComponent[] = [];
  for (const item of split.list.split(" ").filter((part) => part.length > 0)) {
    const name = parseSfString(item);
    if (name === undefined) {
      return undefined;
    }
    covered.push(name as CoveredComponent);
  }
  let created: number | undefined;
  let expires: number | undefined;
  let nonce: string | undefined;
  let keyid: string | undefined;
  let alg: SignatureParams["alg"] | undefined;
  let tag: string | undefined;
  for (const piece of split.rest.split(";")) {
    if (piece.length === 0) {
      continue;
    }
    const eq = piece.indexOf("=");
    if (eq < 0) {
      return undefined;
    }
    const name = piece.slice(0, eq);
    const value = piece.slice(eq + 1);
    switch (name) {
      case "created":
        created = Number.parseInt(value, 10);
        break;
      case "expires":
        expires = Number.parseInt(value, 10);
        break;
      case "nonce":
        nonce = parseSfString(value);
        break;
      case "keyid":
        keyid = parseSfString(value);
        break;
      case "alg": {
        const parsed = parseSfString(value);
        if (parsed === "ed25519" || parsed === "ecdsa-p256-sha256") {
          alg = parsed;
        }
        break;
      }
      case "tag":
        tag = parseSfString(value);
        break;
      default:
        return undefined;
    }
  }
  if (
    created === undefined ||
    expires === undefined ||
    nonce === undefined ||
    keyid === undefined ||
    alg === undefined ||
    tag !== MUTATION_PROFILE_TAG ||
    !Number.isFinite(created) ||
    !Number.isFinite(expires)
  ) {
    return undefined;
  }
  return { created, expires, nonce, keyid, alg, tag: MUTATION_PROFILE_TAG, covered };
}

export function parseSignature(header: string): Buffer | undefined {
  const prefix = `${SIGNATURE_LABEL}=`;
  if (!header.startsWith(prefix)) {
    return undefined;
  }
  return parseSfByteSequence(header.slice(prefix.length));
}

export type VerifyMutationResult =
  | { ok: true; params: SignatureParams }
  | {
      ok: false;
      reason:
        | "headers"
        | "digest"
        | "signature"
        | "alg"
        | "skew"
        | "lifetime"
        | "nonce"
        | "components";
    };

function unixSeconds(iso: string): number | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function verifyMutation(input: {
  message: MutationMessage;
  publicKey: KeyObject;
  nowSeconds: number;
  expectedKeyId: string;
}): VerifyMutationResult {
  const signatureInput = headerLookup(input.message.headers, "signature-input");
  const signatureHeader = headerLookup(input.message.headers, "signature");
  if (signatureInput === undefined || signatureHeader === undefined) {
    return { ok: false, reason: "headers" };
  }
  const params = parseSignatureInput(signatureInput);
  const signature = parseSignature(signatureHeader);
  if (params === undefined || signature === undefined) {
    return { ok: false, reason: "headers" };
  }
  if (params.keyid !== input.expectedKeyId) {
    return { ok: false, reason: "signature" };
  }
  const expectedCovered = coveredFor(input.message);
  if (!arraysEqual(params.covered, expectedCovered)) {
    return { ok: false, reason: "components" };
  }
  const digest = headerLookup(input.message.headers, "content-digest");
  if (digest !== contentDigestSha256(input.message.body)) {
    return { ok: false, reason: "digest" };
  }
  const headerNonce = headerLookup(input.message.headers, "x-hec-nonce");
  if (headerNonce !== params.nonce) {
    return { ok: false, reason: "nonce" };
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.nonce)) {
    return { ok: false, reason: "nonce" };
  }
  const issuedAt = headerLookup(input.message.headers, "x-hec-issued-at");
  const expiresAt = headerLookup(input.message.headers, "x-hec-expires-at");
  if (issuedAt === undefined || expiresAt === undefined) {
    return { ok: false, reason: "headers" };
  }
  const issuedSeconds = unixSeconds(issuedAt);
  const expiresSeconds = unixSeconds(expiresAt);
  if (issuedSeconds === undefined || expiresSeconds === undefined) {
    return { ok: false, reason: "headers" };
  }
  if (Math.abs(params.created - input.nowSeconds) > MAX_CREATED_SKEW_SECONDS) {
    return { ok: false, reason: "skew" };
  }
  if (params.expires - params.created > MAX_LIFETIME_SECONDS || params.expires <= params.created) {
    return { ok: false, reason: "lifetime" };
  }
  if (params.created !== issuedSeconds || params.expires !== expiresSeconds) {
    return { ok: false, reason: "lifetime" };
  }
  const signAlg = params.alg === "ed25519" ? null : "sha256";
  let base: string;
  try {
    base = buildSignatureBase(input.message, params);
  } catch {
    return { ok: false, reason: "components" };
  }
  const ok = cryptoVerify(signAlg, Buffer.from(base, "utf8"), input.publicKey, signature);
  if (!ok) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, params };
}

export function mutationHeaders(input: {
  contentType: string;
  body: Uint8Array;
  operationId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  ifMatch?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": input.contentType,
    "content-length": String(input.body.byteLength),
    "content-digest": contentDigestSha256(input.body),
    "operation-id": input.operationId,
    "x-hec-issued-at": input.issuedAt,
    "x-hec-expires-at": input.expiresAt,
    "x-hec-nonce": input.nonce,
  };
  if (input.ifMatch !== undefined) {
    headers["if-match"] = input.ifMatch;
  }
  return headers;
}
