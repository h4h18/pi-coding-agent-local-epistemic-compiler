import { execFileSync } from "node:child_process";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Compile } from "typebox/compile";
import {
  HostConfigSchema,
  canonicalizeRfc8785,
  type HostConfig,
  type ObjectDigest,
} from "@pi-hec/contracts";
import { issueLeafCertificate, issueSelfSignedCa } from "./pki.js";

export type TlsFiles = {
  caPem: string;
  certPem: string;
  keyPem: string;
};

export type ControlPlaneConfig = {
  mtlsPort: number;
  enrollPort: number;
  host: string;
  jsonBodyLimit: number;
  blobBodyLimit: number;
  leaseWaitMs: number;
  dbPath: string;
  casRoot: string;
  hostLeaseKey: Uint8Array;
  dbResponseKey: Uint8Array;
  hostDek: Uint8Array;
  tls: TlsFiles;
  hostCaCertPem: string;
  hostCaPrivateKeyPem: string;
  hostSignerDigest: ObjectDigest;
  hostPolicyDigest: ObjectDigest;
  hostCapabilityDigest: ObjectDigest;
  hostGrantPolicyDigest: ObjectDigest;
};

export const JSON_BODY_LIMIT = 1_048_576;
export const BLOB_BODY_LIMIT = 16_777_216;
export const DEFAULT_LEASE_WAIT_MS = 2_000;

const HOST_CONFIG = Compile(HostConfigSchema);

export type DeploymentSecurityProfile = HostConfig["deploymentSecurityProfile"];

export type GuaranteeId =
  | "FA_ROOT_CONFIDENTIALITY_NOT_CLAIMED"
  | "FA_ROOT_CREDENTIAL_LOSS"
  | "FA_ROOT_CAN_FORGE_FA_SIGNATURES"
  | "FA_ROOT_CANNOT_BYPASS_UNCOMPROMISED_BROKER"
  | "SINGLE_HOST_NOT_BYZANTINE"
  | "SPLIT_CREDENTIAL_CONFIDENTIALITY"
  | "SPLIT_FALSE_VERDICT_RESISTANCE";

export type IndependentServiceEvidence = {
  identity: string;
  trustDomain: string;
  remoteAttestationVerified: boolean;
  independentlyAdministered: boolean;
};

export type HostStartupServices = {
  credentialGateway?: IndependentServiceEvidence;
  keyManagement?: IndependentServiceEvidence;
  verifierAuthority?: IndependentServiceEvidence;
};

export type HostDeploymentInput = {
  config: HostConfig;
  services: HostStartupServices;
  privilegesDropped: boolean;
};

export type LoadedHostDeployment = {
  config: HostConfig;
  profile: DeploymentSecurityProfile;
  guarantees: readonly GuaranteeId[];
};

export type SignedHostConfig = {
  schemaVersion: 1;
  keyId: string;
  signedAt: string;
  config: HostConfig;
  signature: string;
};

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

export function guaranteeSetForProfile(profile: DeploymentSecurityProfile): readonly GuaranteeId[] {
  switch (profile) {
    case "SINGLE_HOST":
      return [
        "FA_ROOT_CONFIDENTIALITY_NOT_CLAIMED",
        "FA_ROOT_CREDENTIAL_LOSS",
        "FA_ROOT_CAN_FORGE_FA_SIGNATURES",
        "FA_ROOT_CANNOT_BYPASS_UNCOMPROMISED_BROKER",
        "SINGLE_HOST_NOT_BYZANTINE",
      ];
    case "SPLIT_CREDENTIALS":
      return ["SPLIT_CREDENTIAL_CONFIDENTIALITY", "FA_ROOT_CANNOT_BYPASS_UNCOMPROMISED_BROKER"];
    case "SPLIT_CREDENTIALS_AND_VERIFIER":
      return [
        "SPLIT_CREDENTIAL_CONFIDENTIALITY",
        "SPLIT_FALSE_VERDICT_RESISTANCE",
        "FA_ROOT_CANNOT_BYPASS_UNCOMPROMISED_BROKER",
      ];
    default: {
      const exhaustive: never = profile;
      throw new Error(`unhandled profile ${String(exhaustive)}`);
    }
  }
}

export function validateListenAddress(listenAddress: string): void {
  const host = extractListenHost(listenAddress);
  if (host === undefined || isWildcardOrPublic(host)) {
    throw new Error(`listen address ${listenAddress} is wildcard or public`);
  }
}

export function validateHostDeployment(input: HostDeploymentInput): LoadedHostDeployment {
  if (input.privilegesDropped) {
    throw new Error("host config must be loaded before dropping privileges");
  }
  if (!HOST_CONFIG.Check(input.config)) {
    throw new Error("host config schema invalid");
  }
  validateListenAddress(input.config.control.listenAddress);
  validateProfileIdentities(input.config, input.services);
  return {
    config: input.config,
    profile: input.config.deploymentSecurityProfile,
    guarantees: guaranteeSetForProfile(input.config.deploymentSecurityProfile),
  };
}

export function signHostConfig(
  config: HostConfig,
  privateKey: KeyObject,
  keyId: string,
): SignedHostConfig {
  if (!HOST_CONFIG.Check(config)) {
    throw new Error("host config schema invalid");
  }
  const canonical = canonicalizeRfc8785(config);
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
  return {
    schemaVersion: 1,
    keyId,
    signedAt: nowIso(),
    config,
    signature,
  };
}

export function loadSignedHostConfig(input: {
  filePath: string;
  publicKey: KeyObject;
  expectedKeyId: string;
  services: HostStartupServices;
  privilegesDropped: boolean;
}): LoadedHostDeployment {
  if (input.privilegesDropped) {
    throw new Error("host config must be loaded before dropping privileges");
  }
  assertHostConfigPermissions(input.filePath);
  const parsed = JSON.parse(readFileSync(input.filePath, "utf8")) as SignedHostConfig;
  if (parsed.keyId !== input.expectedKeyId) {
    throw new Error("host config key id mismatch");
  }
  const canonical = canonicalizeRfc8785(parsed.config);
  const ok = cryptoVerify(
    null,
    Buffer.from(canonical, "utf8"),
    input.publicKey,
    Buffer.from(parsed.signature, "base64"),
  );
  if (!ok) {
    throw new Error("host config signature invalid");
  }
  return validateHostDeployment({
    config: parsed.config,
    services: input.services,
    privilegesDropped: false,
  });
}

export function assertHostConfigPermissions(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777;
  if (process.platform !== "win32") {
    if (mode !== 0o600) {
      throw new Error(`host config mode must be 0600, got ${mode.toString(8)}`);
    }
    return;
  }
  if ((mode & 0o044) !== 0) {
    throw new Error("host config ACL/mode must not be world-readable");
  }
  if (windowsWorldReadable(filePath)) {
    throw new Error("host config ACL must be owner-only equivalent of 0600");
  }
}

function windowsWorldReadable(filePath: string): boolean {
  try {
    const output = execFileSync("icacls", [filePath], { encoding: "utf8" });
    return /Everyone:\([^\)]*R/i.test(output) || /BUILTIN\\Users:\([^\)]*R/i.test(output);
  } catch {
    return true;
  }
}

function extractListenHost(listenAddress: string): string | undefined {
  const trimmed = listenAddress.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end <= 1) {
      return undefined;
    }
    return trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/u.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

function isWildcardOrPublic(host: string): boolean {
  const normalized = host.toLowerCase();
  if (
    normalized === "*" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  ) {
    return true;
  }
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") {
    return false;
  }
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) {
    return !isPrivateIpv4(ipv4);
  }
  if (normalized.includes(":")) {
    return !isPrivateIpv6(normalized);
  }
  return true;
}

function parseIpv4(host: string): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const nums = parts.map((part) => Number(part));
  if (nums.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return a === 127;
}

function isPrivateIpv6(host: string): boolean {
  const compact = host.toLowerCase();
  return compact.startsWith("fc") || compact.startsWith("fd") || compact.startsWith("fe80");
}

function validateProfileIdentities(config: HostConfig, services: HostStartupServices): void {
  switch (config.deploymentSecurityProfile) {
    case "SINGLE_HOST":
      return;
    case "SPLIT_CREDENTIALS":
      assertSplitCredentials(config, services, false);
      return;
    case "SPLIT_CREDENTIALS_AND_VERIFIER":
      assertSplitCredentials(config, services, true);
      return;
    default: {
      const exhaustive: never = config.deploymentSecurityProfile;
      throw new Error(`unhandled profile ${String(exhaustive)}`);
    }
  }
}

function assertSplitCredentials(
  config: HostConfig,
  services: HostStartupServices,
  requireVerifier: boolean,
): void {
  const gateway = config.independentServices.credentialGatewayIdentity;
  const kms = config.independentServices.keyManagementIdentity;
  if (gateway === undefined || kms === undefined) {
    throw new Error("SPLIT_CREDENTIALS fails startup: missing independent service identities");
  }
  if (gateway === kms) {
    throw new Error("SPLIT_CREDENTIALS fails startup: identity equality");
  }
  const gatewayEvidence = services.credentialGateway;
  const kmsEvidence = services.keyManagement;
  if (gatewayEvidence === undefined || kmsEvidence === undefined) {
    throw new Error("SPLIT_CREDENTIALS fails startup: missing remote attestation");
  }
  if (gatewayEvidence.identity !== gateway || kmsEvidence.identity !== kms) {
    throw new Error("SPLIT_CREDENTIALS fails startup: identity equality");
  }
  if (!gatewayEvidence.remoteAttestationVerified || !kmsEvidence.remoteAttestationVerified) {
    throw new Error("SPLIT_CREDENTIALS fails startup: missing remote attestation");
  }
  if (!gatewayEvidence.independentlyAdministered || !kmsEvidence.independentlyAdministered) {
    throw new Error(
      "SPLIT_CREDENTIALS fails startup: identities must be independently administered",
    );
  }
  if (gatewayEvidence.trustDomain === kmsEvidence.trustDomain) {
    throw new Error("SPLIT_CREDENTIALS fails startup: same root trust domain");
  }
  if (!requireVerifier) {
    return;
  }
  const verifier = config.independentServices.verifierAuthorityIdentity;
  const verifierEvidence = services.verifierAuthority;
  if (verifier === undefined || verifierEvidence === undefined) {
    throw new Error("SPLIT_CREDENTIALS_AND_VERIFIER fails startup: missing verifier identity");
  }
  if (verifier === gateway || verifier === kms) {
    throw new Error("SPLIT_CREDENTIALS_AND_VERIFIER fails startup: identity equality");
  }
  if (
    !verifierEvidence.remoteAttestationVerified ||
    !verifierEvidence.independentlyAdministered ||
    verifierEvidence.identity !== verifier
  ) {
    throw new Error("SPLIT_CREDENTIALS_AND_VERIFIER fails startup: missing remote attestation");
  }
  if (
    verifierEvidence.trustDomain === gatewayEvidence.trustDomain ||
    verifierEvidence.trustDomain === kmsEvidence.trustDomain
  ) {
    throw new Error("SPLIT_CREDENTIALS_AND_VERIFIER fails startup: same root trust domain");
  }
}

export const ROTATED_MTLS_IDENTITIES = [
  "ca",
  "server",
  "admin",
  "broker",
  "runner",
  "worker",
] as const;

export function writeRotatedTestPki(outputDir: string): {
  outputDir: string;
  identities: readonly string[];
} {
  mkdirSync(outputDir, { recursive: true });
  const ca = issueSelfSignedCa("pi-hec-rotate-ca");
  writePemPair(outputDir, "ca", ca.certPem, ca.keyPem);
  const notBefore = new Date(Date.UTC(2026, 0, 1));
  const notAfter = new Date(Date.UTC(2049, 11, 31));
  for (const identity of ["server", "admin", "broker", "runner", "worker"] as const) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const leaf = issueLeafCertificate({
      caCertPem: ca.certPem,
      caPrivateKey: ca.privateKey,
      spkiDer: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })),
      subject: identity,
      notBefore,
      notAfter,
    });
    const keyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    if (typeof keyPem !== "string") {
      throw new Error("expected pem private key");
    }
    writePemPair(outputDir, identity, leaf.certificatePem, keyPem);
  }
  writeFileSync(
    path.join(outputDir, "rotation.json"),
    `${JSON.stringify({ schemaVersion: 1, identities: ROTATED_MTLS_IDENTITIES, routesUnchanged: true }, null, 2)}\n`,
  );
  return { outputDir, identities: ROTATED_MTLS_IDENTITIES };
}

function writePemPair(outputDir: string, name: string, certPem: string, keyPem: string): void {
  writeFileSync(path.join(outputDir, `${name}.crt.pem`), certPem, { mode: 0o644 });
  writeFileSync(path.join(outputDir, `${name}.key.pem`), keyPem, { mode: 0o600 });
}
