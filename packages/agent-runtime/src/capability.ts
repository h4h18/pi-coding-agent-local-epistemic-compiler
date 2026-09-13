import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  asCapabilityTokenId,
  randomPrefixedUuidV7,
  sha256Utf8,
  type AgentRole,
  type ArtifactType,
  type CapabilityToken,
  type SpawnRequest,
  type ToolProfile,
} from "@pi-hec/contracts";
import { ROLE_ARTIFACT_TYPES, implementerMayNotAccept } from "@pi-hec/domain";

export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

export function mintCapabilityToken(input: {
  runId: CapabilityToken["runId"];
  nodeId: string;
  agentId: CapabilityToken["agentId"];
  role: AgentRole;
  toolProfile: ToolProfile;
  leaseId?: NonNullable<SpawnRequest["workspaceLeaseId"]>;
  now: string;
  expiresAt: string;
}): CapabilityToken {
  const token: CapabilityToken = {
    schemaVersion: 1,
    tokenId: asCapabilityTokenId(randomPrefixedUuidV7("cap_")),
    runId: input.runId,
    nodeId: input.nodeId,
    agentId: input.agentId,
    role: input.role,
    toolProfile: input.toolProfile,
    allowedArtifactTypes: [...ROLE_ARTIFACT_TYPES[input.role]],
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    nonce: randomBytes(16).toString("hex"),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
  };
  return token;
}

export function tokenMac(token: CapabilityToken, secret: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(
      `${token.tokenId}|${token.runId}|${token.nodeId}|${token.agentId}|${token.role}|${token.nonce}`,
    )
    .digest("hex");
}

export function assertToken(
  token: CapabilityToken,
  expected: {
    runId: CapabilityToken["runId"];
    nodeId: string;
    agentId: CapabilityToken["agentId"];
    now: string;
    secret?: Uint8Array;
    mac?: string;
  },
): void {
  if (token.runId !== expected.runId || token.nodeId !== expected.nodeId) {
    throw new CapabilityError("capability token scope mismatch");
  }
  if (token.agentId !== expected.agentId) {
    throw new CapabilityError("capability token agent mismatch");
  }
  if (token.expiresAt <= expected.now) {
    throw new CapabilityError("capability token expired");
  }
  if (expected.secret !== undefined && expected.mac !== undefined) {
    const actual = Buffer.from(tokenMac(token, expected.secret), "hex");
    const claimed = Buffer.from(expected.mac, "hex");
    if (actual.byteLength !== claimed.byteLength || !timingSafeEqual(actual, claimed)) {
      throw new CapabilityError("capability token mac invalid");
    }
  }
}

export function assertArtifactAllowed(token: CapabilityToken, artifactType: ArtifactType): void {
  if (!token.allowedArtifactTypes.includes(artifactType)) {
    throw new CapabilityError(`role ${token.role} cannot submit ${artifactType}`);
  }
  if (implementerMayNotAccept(token.role, artifactType)) {
    throw new CapabilityError("implementer cannot self-approve");
  }
}

export function tokenDigest(token: CapabilityToken): string {
  return sha256Utf8(`${token.tokenId}:${token.nonce}`);
}
