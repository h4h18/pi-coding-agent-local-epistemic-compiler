import {
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import {
  asObjectDigest,
  envelopeObjectDigest,
  isObjectDigest,
  payloadDigest,
  signatureInputDigest,
  type ApprovalDecision,
  type ApprovalGrant,
  type ApprovalSubject,
  type ArtifactEnvelope,
  type JsonValue,
  type ObjectDigest,
} from "@pi-hec/contracts";

export type UserPresenceProof = {
  readonly challengeDigest: ObjectDigest;
  readonly authenticatorPresent: true;
  readonly coversChallenge: true;
};

export type UserPresence = {
  prove(challengeDigest: ObjectDigest): UserPresenceProof;
};

export type ApprovalChallenge = {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly projectId: string;
  readonly scope: { readonly kind: "project" } | { readonly kind: "run"; readonly runId: string };
  readonly action:
    | "cloud-egress"
    | "command"
    | "workspace-promotion"
    | "project-trust"
    | "project-policy"
    | "workspace-registration";
  readonly subjectObjectDigest: ObjectDigest;
  readonly policyObjectDigest: ObjectDigest;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly displayArtifactObjectDigest: ObjectDigest;
};

export type SignedApprovalDecision = ArtifactEnvelope<ApprovalDecision>;
export type SignedApprovalGrant = ArtifactEnvelope<ApprovalGrant>;

export type RunGrantBinding = {
  readonly scope: "run";
  readonly action: "cloud-egress" | "command" | "workspace-promotion";
  readonly runId: string;
};

export type ProjectGrantBinding = {
  readonly scope: "project";
  readonly action: "project-trust" | "project-policy" | "workspace-registration";
};

export type GrantBinding = RunGrantBinding | ProjectGrantBinding;

export class ApprovalError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ApprovalError";
    this.reason = reason;
  }
}

export class ApprovalNonceRegistry {
  readonly #used = new Set<string>();

  constructor(existing: Iterable<string> = []) {
    for (const nonce of existing) {
      this.#used.add(nonce);
    }
  }

  snapshot(): readonly string[] {
    return [...this.#used];
  }

  has(nonce: string): boolean {
    return this.#used.has(nonce);
  }

  consume(nonce: string): void {
    if (this.#used.has(nonce)) {
      throw new ApprovalError("nonce-replay");
    }
    this.#used.add(nonce);
  }
}

export class GrantConsumptionRegistry {
  readonly #used = new Set<string>();

  constructor(existing: Iterable<string> = []) {
    for (const digest of existing) {
      this.#used.add(digest);
    }
  }

  snapshot(): readonly string[] {
    return [...this.#used];
  }

  consume(grantObjectDigest: ObjectDigest): void {
    if (this.#used.has(grantObjectDigest)) {
      throw new ApprovalError("grant-consumed");
    }
    this.#used.add(grantObjectDigest);
  }

  isConsumed(grantObjectDigest: ObjectDigest): boolean {
    return this.#used.has(grantObjectDigest);
  }
}

export function platformUserPresence(): UserPresence {
  return {
    prove(): UserPresenceProof {
      throw new ApprovalError("authenticator-absent");
    },
  };
}

export function freshApprovalNonce(): string {
  return randomBytes(32).toString("base64url");
}

export type ApprovalDigestSchema =
  "ApprovalDecision" | "ApprovalChallenge" | "ApprovalSubject" | "ApprovalGrant";

export function approvalObjectDigest(
  schemaName: ApprovalDigestSchema,
  value: unknown,
): ObjectDigest {
  return asObjectDigest(
    payloadDigest({
      schemaName,
      schemaVersion: 1,
      payload: jsonValue(value),
    }),
  );
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function assertNonce256(nonce: string): void {
  const decoded = Buffer.from(nonce, "base64url");
  if (decoded.byteLength !== 32) {
    throw new ApprovalError("nonce-invalid");
  }
}

function signEnvelope<T>(input: {
  schemaName: string;
  payload: T;
  privateKey: KeyObject;
  keyId: string;
  signerCertificateObjectDigest: ObjectDigest;
  signedAt: string;
}): ArtifactEnvelope<T> {
  const payloadDigestValue = payloadDigest({
    schemaName: input.schemaName,
    schemaVersion: 1,
    payload: jsonValue(input.payload),
  });
  const inputDigest = signatureInputDigest({
    schemaName: input.schemaName,
    schemaVersion: 1,
    payloadDigest: payloadDigestValue,
    keyId: input.keyId,
    algorithm: "Ed25519",
    signedAt: input.signedAt,
    signerCertificateObjectDigest: input.signerCertificateObjectDigest,
  });
  const signature = cryptoSign(null, Buffer.from(inputDigest, "utf8"), input.privateKey);
  return {
    schemaName: input.schemaName,
    schemaVersion: 1,
    payload: input.payload,
    payloadDigest: payloadDigestValue,
    signatures: [
      {
        keyId: input.keyId,
        algorithm: "Ed25519",
        signedAt: input.signedAt,
        signerCertificateObjectDigest: input.signerCertificateObjectDigest,
        signature: signature.toString("base64"),
      },
    ],
  };
}

function verifyEnvelopeSignature<T>(
  envelope: ArtifactEnvelope<T>,
  publicKey: KeyObject,
  expectedKeyId: string,
): void {
  const first = envelope.signatures[0];
  if (first === undefined || envelope.signatures.length !== 1) {
    throw new ApprovalError("signature-missing");
  }
  if (first.keyId !== expectedKeyId || first.algorithm !== "Ed25519") {
    throw new ApprovalError("ui-key");
  }
  if (!isObjectDigest(first.signerCertificateObjectDigest)) {
    throw new ApprovalError("signature-malformed");
  }
  const expectedPayload = payloadDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: jsonValue(envelope.payload),
  });
  if (expectedPayload !== envelope.payloadDigest) {
    throw new ApprovalError("payload-digest");
  }
  const inputDigest = signatureInputDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payloadDigest: envelope.payloadDigest,
    keyId: first.keyId,
    algorithm: first.algorithm,
    signedAt: first.signedAt,
    signerCertificateObjectDigest: first.signerCertificateObjectDigest,
  });
  const provided = Buffer.from(first.signature, "base64");
  if (!cryptoVerify(null, Buffer.from(inputDigest, "utf8"), publicKey, provided)) {
    throw new ApprovalError("ui-key");
  }
}

export function grantBindingForSubject(subject: ApprovalSubject): GrantBinding {
  switch (subject.kind) {
    case "cloud-egress":
      return { scope: "run", action: "cloud-egress", runId: subject.runId };
    case "command":
      return { scope: "run", action: "command", runId: subject.runId };
    case "workspace-promotion":
      return { scope: "run", action: "workspace-promotion", runId: subject.runId };
    case "project-trust":
      return { scope: "project", action: "project-trust" };
    case "project-policy":
      return { scope: "project", action: "project-policy" };
    case "workspace-registration":
      return { scope: "project", action: "workspace-registration" };
    default: {
      const exhaustive: never = subject;
      throw new ApprovalError(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function assertBindingMatches(subject: ApprovalSubject, grant: ApprovalGrant): void {
  const expected = grantBindingForSubject(subject);
  if (grant.scope !== expected.scope || grant.action !== expected.action) {
    throw new ApprovalError("subject-mismatch");
  }
  if (grant.scope === "run" && expected.scope === "run" && grant.runId !== expected.runId) {
    throw new ApprovalError("subject-mismatch");
  }
}

function envelopeDigest<T>(envelope: ArtifactEnvelope<T>): ObjectDigest {
  return envelopeObjectDigest({
    schemaName: envelope.schemaName,
    schemaVersion: envelope.schemaVersion,
    payload: jsonValue(envelope.payload),
    payloadDigest: envelope.payloadDigest,
    signatures: envelope.signatures,
  });
}

export function signApprovalDecision(input: {
  decision: Omit<ApprovalDecision, "nonce"> & { nonce?: string };
  uiPrivateKey: KeyObject;
  uiKeyId: string;
  signerCertificateObjectDigest: ObjectDigest;
  userPresence: UserPresence;
  challenge: ApprovalChallenge;
  subject: ApprovalSubject;
  now: string;
}): SignedApprovalDecision {
  const nonce = input.decision.nonce ?? freshApprovalNonce();
  assertNonce256(nonce);
  const subjectDigest = approvalObjectDigest("ApprovalSubject", input.subject);
  const challengeDigest = approvalObjectDigest("ApprovalChallenge", input.challenge);
  if (
    subjectDigest !== input.decision.subjectObjectDigest ||
    subjectDigest !== input.challenge.subjectObjectDigest
  ) {
    throw new ApprovalError("subject-mismatch");
  }
  if (challengeDigest !== input.decision.challengeObjectDigest) {
    throw new ApprovalError("challenge-mismatch");
  }
  if (input.challenge.policyObjectDigest !== input.decision.policyObjectDigest) {
    throw new ApprovalError("policy-mismatch");
  }
  if (input.challenge.displayArtifactObjectDigest !== input.decision.displayArtifactObjectDigest) {
    throw new ApprovalError("display-mismatch");
  }
  if (
    input.challenge.approvalId !== input.decision.approvalId ||
    input.challenge.projectId !== input.decision.projectId
  ) {
    throw new ApprovalError("challenge-mismatch");
  }
  const proof = input.userPresence.prove(challengeDigest);
  if (proof.challengeDigest !== challengeDigest) {
    throw new ApprovalError("presence-mismatch");
  }
  const decision: ApprovalDecision = {
    ...input.decision,
    schemaVersion: 1,
    nonce,
  };
  return signEnvelope({
    schemaName: "ApprovalDecision",
    payload: decision,
    privateKey: input.uiPrivateKey,
    keyId: input.uiKeyId,
    signerCertificateObjectDigest: input.signerCertificateObjectDigest,
    signedAt: input.now,
  });
}

export type FaIdentityLookup = {
  getRunner(runnerId: string): { revokedAt: string | undefined } | undefined;
};

export function verifyDecisionAndIssueGrant(input: {
  decision: SignedApprovalDecision;
  challenge: ApprovalChallenge;
  subject: ApprovalSubject;
  uiPublicKey: KeyObject;
  uiKeyId: string;
  brokerPrivateKey: KeyObject;
  brokerKeyId: string;
  brokerCertificateObjectDigest: ObjectDigest;
  authenticatedPrincipalId: string;
  nonceRegistry: ApprovalNonceRegistry;
  now: string;
  store?: FaIdentityLookup;
  faRunnerId?: string;
}): SignedApprovalGrant {
  if (input.faRunnerId !== undefined) {
    const fa = input.store?.getRunner(input.faRunnerId);
    if (fa === undefined || fa.revokedAt !== undefined) {
      throw new ApprovalError("revoked");
    }
  }
  verifyEnvelopeSignature(input.decision, input.uiPublicKey, input.uiKeyId);
  const payload = input.decision.payload;
  if (payload.principalId !== input.authenticatedPrincipalId) {
    throw new ApprovalError("principal");
  }
  assertNonce256(payload.nonce);
  input.nonceRegistry.consume(payload.nonce);
  if (payload.expiresAt <= input.now || input.challenge.expiresAt <= input.now) {
    throw new ApprovalError("expired");
  }
  if (payload.decision !== "APPROVE") {
    throw new ApprovalError("denied");
  }
  const subjectDigest = approvalObjectDigest("ApprovalSubject", input.subject);
  const challengeDigest = approvalObjectDigest("ApprovalChallenge", input.challenge);
  if (
    payload.subjectObjectDigest !== subjectDigest ||
    input.challenge.subjectObjectDigest !== subjectDigest
  ) {
    throw new ApprovalError("subject-mismatch");
  }
  if (payload.challengeObjectDigest !== challengeDigest) {
    throw new ApprovalError("challenge-mismatch");
  }
  if (payload.policyObjectDigest !== input.challenge.policyObjectDigest) {
    throw new ApprovalError("policy-mismatch");
  }
  if (payload.displayArtifactObjectDigest !== input.challenge.displayArtifactObjectDigest) {
    throw new ApprovalError("display-mismatch");
  }
  if (
    payload.approvalId !== input.challenge.approvalId ||
    payload.projectId !== input.challenge.projectId
  ) {
    throw new ApprovalError("challenge-mismatch");
  }
  const expected = grantBindingForSubject(input.subject);
  if (input.challenge.action !== expected.action) {
    throw new ApprovalError("subject-mismatch");
  }
  const grant = grantFromDecision({
    payload,
    binding: expected,
    now: input.now,
    decisionDigest: envelopeDigest(input.decision),
  });
  return signEnvelope({
    schemaName: "ApprovalGrant",
    payload: grant,
    privateKey: input.brokerPrivateKey,
    keyId: input.brokerKeyId,
    signerCertificateObjectDigest: input.brokerCertificateObjectDigest,
    signedAt: input.now,
  });
}

function grantFromDecision(input: {
  payload: ApprovalDecision;
  binding: GrantBinding;
  now: string;
  decisionDigest: ObjectDigest;
}): ApprovalGrant {
  const base = {
    schemaVersion: 1 as const,
    approvalId: input.payload.approvalId,
    projectId: input.payload.projectId,
    principalId: input.payload.principalId,
    challengeObjectDigest: input.payload.challengeObjectDigest,
    approvalDecisionObjectDigest: input.decisionDigest,
    subjectObjectDigest: input.payload.subjectObjectDigest,
    policyObjectDigest: input.payload.policyObjectDigest,
    issuedAt: input.now,
    expiresAt: input.payload.expiresAt,
  };
  switch (input.binding.scope) {
    case "run":
      return {
        ...base,
        scope: "run",
        runId: input.binding.runId,
        action: input.binding.action,
      };
    case "project":
      return {
        ...base,
        scope: "project",
        action: input.binding.action,
      };
    default: {
      const exhaustive: never = input.binding;
      throw new ApprovalError(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function consumeGrant(input: {
  grant: SignedApprovalGrant;
  brokerPublicKey: KeyObject;
  brokerKeyId: string;
  subject: ApprovalSubject;
  now: string;
  registry: GrantConsumptionRegistry;
  expectedAction?: ApprovalGrant["action"];
  expectedPromotionMode?: "ENTRY_JOURNALED" | "ROOT_SWAP";
}): ObjectDigest {
  verifyEnvelopeSignature(input.grant, input.brokerPublicKey, input.brokerKeyId);
  const grant = input.grant.payload;
  if (grant.expiresAt <= input.now) {
    throw new ApprovalError("expired");
  }
  assertBindingMatches(input.subject, grant);
  const subjectDigest = approvalObjectDigest("ApprovalSubject", input.subject);
  if (grant.subjectObjectDigest !== subjectDigest) {
    throw new ApprovalError("subject-mismatch");
  }
  if (input.expectedAction !== undefined && grant.action !== input.expectedAction) {
    throw new ApprovalError("subject-mismatch");
  }
  if (input.expectedPromotionMode !== undefined) {
    if (input.subject.kind !== "workspace-promotion") {
      throw new ApprovalError("mode-mismatch");
    }
    if (input.subject.promotionMode !== input.expectedPromotionMode) {
      throw new ApprovalError("mode-mismatch");
    }
  }
  const digest = envelopeDigest(input.grant);
  input.registry.consume(digest);
  return digest;
}
