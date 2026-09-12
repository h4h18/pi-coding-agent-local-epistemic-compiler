import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  guaranteeSetForProfile,
  loadSignedHostConfig,
  signHostConfig,
  validateHostDeployment,
} from "../../../faex1/apps/control-plane/src/config.js";
import { sampleHostConfig } from "./helpers.js";

test("SINGLE_HOST reports documented FA-root confidentiality and credential-loss guarantees", () => {
  const loaded = validateHostDeployment({
    config: sampleHostConfig(),
    services: {},
    privilegesDropped: false,
  });
  expect(loaded.profile).toBe("SINGLE_HOST");
  const guarantees = guaranteeSetForProfile("SINGLE_HOST");
  expect(guarantees).toEqual(loaded.guarantees);
  expect(guarantees).toContain("FA_ROOT_CONFIDENTIALITY_NOT_CLAIMED");
  expect(guarantees).toContain("FA_ROOT_CREDENTIAL_LOSS");
  expect(guarantees).toContain("FA_ROOT_CAN_FORGE_FA_SIGNATURES");
  expect(guarantees).toContain("FA_ROOT_CANNOT_BYPASS_UNCOMPROMISED_BROKER");
  expect(guarantees).toContain("SINGLE_HOST_NOT_BYZANTINE");
});

test("SPLIT_CREDENTIALS with equal identities or missing attestation fails startup", () => {
  const equal = sampleHostConfig({
    deploymentSecurityProfile: "SPLIT_CREDENTIALS",
    independentServices: {
      credentialGatewayIdentity: "cred-gw@shared",
      keyManagementIdentity: "cred-gw@shared",
    },
  });
  expect(() =>
    validateHostDeployment({
      config: equal,
      services: {
        credentialGateway: {
          identity: "cred-gw@shared",
          trustDomain: "shared",
          remoteAttestationVerified: true,
          independentlyAdministered: true,
        },
        keyManagement: {
          identity: "cred-gw@shared",
          trustDomain: "other",
          remoteAttestationVerified: true,
          independentlyAdministered: true,
        },
      },
      privilegesDropped: false,
    }),
  ).toThrow(/identity equality|fails startup/i);

  const sameDomain = sampleHostConfig({
    deploymentSecurityProfile: "SPLIT_CREDENTIALS",
    independentServices: {
      credentialGatewayIdentity: "cred-gw@alpha",
      keyManagementIdentity: "kms@alpha",
    },
  });
  expect(() =>
    validateHostDeployment({
      config: sameDomain,
      services: {
        credentialGateway: {
          identity: "cred-gw@alpha",
          trustDomain: "alpha",
          remoteAttestationVerified: true,
          independentlyAdministered: true,
        },
        keyManagement: {
          identity: "kms@alpha",
          trustDomain: "alpha",
          remoteAttestationVerified: true,
          independentlyAdministered: true,
        },
      },
      privilegesDropped: false,
    }),
  ).toThrow(/trust domain|fails startup/i);

  const missingAttestation = sampleHostConfig({
    deploymentSecurityProfile: "SPLIT_CREDENTIALS",
    independentServices: {
      credentialGatewayIdentity: "cred-gw@alpha",
      keyManagementIdentity: "kms@beta",
    },
  });
  expect(() =>
    validateHostDeployment({
      config: missingAttestation,
      services: {
        credentialGateway: {
          identity: "cred-gw@alpha",
          trustDomain: "alpha",
          remoteAttestationVerified: false,
          independentlyAdministered: true,
        },
        keyManagement: {
          identity: "kms@beta",
          trustDomain: "beta",
          remoteAttestationVerified: true,
          independentlyAdministered: true,
        },
      },
      privilegesDropped: false,
    }),
  ).toThrow(/attestation|fails startup/i);
});

test("wildcard and public listen addresses fail validation", () => {
  for (const listenAddress of ["0.0.0.0", "::", "*", "[::]", "0.0.0.0:8443", "8.8.8.8"] as const) {
    expect(() =>
      validateHostDeployment({
        config: sampleHostConfig({
          control: { ...sampleHostConfig().control, listenAddress },
        }),
        services: {},
        privilegesDropped: false,
      }),
    ).toThrow(/listen|wildcard|public/i);
  }
});

test("signed host config is refused after privileges drop and when mode is world-readable", () => {
  const keys = generateKeyPairSync("ed25519");
  const config = sampleHostConfig();
  const dir = mkdtempSync(path.join(tmpdir(), "hec-hostcfg-"));
  const filePath = path.join(dir, "host-config.json");
  const signed = signHostConfig(config, keys.privateKey, "host-cfg-1");
  writeFileSync(filePath, `${JSON.stringify(signed)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);

  expect(() =>
    loadSignedHostConfig({
      filePath,
      publicKey: keys.publicKey,
      expectedKeyId: "host-cfg-1",
      services: {},
      privilegesDropped: true,
    }),
  ).toThrow(/privileges/i);

  mkdirSync(path.join(dir, "open"), { recursive: true });
  const openPath = path.join(dir, "open", "host-config.json");
  writeFileSync(openPath, `${JSON.stringify(signed)}\n`, { encoding: "utf8", mode: 0o644 });
  chmodSync(openPath, 0o644);
  expect(() =>
    loadSignedHostConfig({
      filePath: openPath,
      publicKey: keys.publicKey,
      expectedKeyId: "host-cfg-1",
      services: {},
      privilegesDropped: false,
    }),
  ).toThrow(/0600|acl|mode/i);
});
