import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { authenticatedScopeBrand, HTTP_OPERATIONS } from "@pi-hec/contracts";
import type { ObjectDigest } from "@pi-hec/contracts";
import {
  StaticIdentityStore,
  authorizeOperation,
  constructPrincipalScope,
  mintCapability,
  verifyCapability,
} from "../src/index.js";
import type { CertificatePrincipalRecord } from "../src/index.js";

const GRANT =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectDigest;

function adminRecord(): CertificatePrincipalRecord {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    principalId: "admin-1",
    identityKind: "admin",
    certificateSerial: "aa01",
    spkiSha256: "bb".repeat(32),
    revokedAt: undefined,
    notAfter: "2099-01-01T00:00:00.000Z",
    audiences: ["admin"],
    ed25519PublicKey: publicKey,
  };
}

test("constructPrincipalScope is branded and only identity constructs it", () => {
  const scope = constructPrincipalScope({
    record: adminRecord(),
    grants: [
      { projectId: "proj-a", roles: ["admin"], grantObjectDigest: GRANT, revokedAt: undefined },
    ],
    authenticatedAt: "2026-08-28T00:00:00.000Z",
  });
  expect(scope[authenticatedScopeBrand]).toBe(true);
  expect(scope.principalId).toBe("admin-1");
  expect(scope.projectGrants).toHaveLength(1);
});

test("admin identity lists all projects from the store port", () => {
  const record = adminRecord();
  const store = new StaticIdentityStore({
    records: [record],
    grants: {},
    projects: [{ projectId: "proj-a", grantObjectDigest: GRANT }],
  });
  expect(store.listAllProjects()).toEqual([{ projectId: "proj-a", grantObjectDigest: GRANT }]);
  expect(store.lookupBySerialAndSpki("aa01", "bb".repeat(32))?.principalId).toBe("admin-1");
});

test("wrong audience is not_found never allow", () => {
  const createProject = HTTP_OPERATIONS.find(
    (operation) => operation.operationId === "createProject",
  );
  const getProject = HTTP_OPERATIONS.find((operation) => operation.operationId === "getProject");
  if (createProject === undefined || getProject === undefined) {
    throw new Error("missing operations");
  }
  const broker = constructPrincipalScope({
    record: {
      ...adminRecord(),
      principalId: "broker-1",
      identityKind: "broker",
      audiences: ["broker"],
    },
    grants: [
      { projectId: "proj-a", roles: ["broker"], grantObjectDigest: GRANT, revokedAt: undefined },
    ],
    authenticatedAt: "2026-08-28T00:00:00.000Z",
  });
  expect(authorizeOperation({ scope: broker, operation: createProject })).toEqual({
    kind: "not_found",
  });
  const enrollProject = HTTP_OPERATIONS.find(
    (operation) => operation.operationId === "enrollProject",
  );
  if (enrollProject === undefined) {
    throw new Error("missing enrollProject");
  }
  expect(authorizeOperation({ scope: broker, operation: enrollProject })).toEqual({
    kind: "allow",
    projectId: undefined,
  });
  const grantRunnerProject = HTTP_OPERATIONS.find(
    (operation) => operation.operationId === "grantRunnerProject",
  );
  if (grantRunnerProject === undefined) {
    throw new Error("missing grantRunnerProject");
  }
  expect(
    authorizeOperation({
      scope: broker,
      operation: grantRunnerProject,
      params: { projectId: "proj-a" },
    }),
  ).toEqual({ kind: "allow", projectId: "proj-a" });
  expect(
    authorizeOperation({
      scope: undefined,
      operation: getProject,
      params: { projectId: "proj-a" },
    }),
  ).toEqual({ kind: "unauthenticated" });
  expect(
    authorizeOperation({
      scope: broker,
      operation: getProject,
      params: { projectId: "missing" },
    }),
  ).toEqual({ kind: "not_found" });
});

test("worker audience can lease jobs", () => {
  const lease = HTTP_OPERATIONS.find((operation) => operation.operationId === "leaseRunnerJob");
  const heartbeat = HTTP_OPERATIONS.find(
    (operation) => operation.operationId === "heartbeatOperation",
  );
  if (lease === undefined || heartbeat === undefined) {
    throw new Error("missing operations");
  }
  const worker = constructPrincipalScope({
    record: {
      ...adminRecord(),
      principalId: "worker-1",
      identityKind: "worker",
      audiences: ["worker"],
    },
    grants: [
      { projectId: "proj-a", roles: ["worker"], grantObjectDigest: GRANT, revokedAt: undefined },
    ],
    authenticatedAt: "2026-08-28T00:00:00.000Z",
  });
  expect(authorizeOperation({ scope: worker, operation: lease })).toEqual({
    kind: "allow",
    projectId: undefined,
  });
  expect(
    authorizeOperation({
      scope: worker,
      operation: heartbeat,
      params: { projectId: "proj-a", operationId: "op_1" },
    }),
  ).toEqual({ kind: "allow", projectId: "proj-a" });
});

test("capability tokens are one-purpose and project-scoped", () => {
  const hostKey = Buffer.alloc(32, 7);
  const signed = mintCapability({
    hostKey,
    purpose: "blob-write",
    projectId: "proj-a",
    principalId: "broker-1",
    issuedAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:02:00.000Z",
  });
  expect(
    verifyCapability({
      hostKey,
      signed,
      now: "2026-08-28T00:01:00.000Z",
      purpose: "blob-write",
      projectId: "proj-a",
      principalId: "broker-1",
    }).ok,
  ).toBe(true);
  expect(
    verifyCapability({
      hostKey,
      signed,
      now: "2026-08-28T00:01:00.000Z",
      purpose: "lease-claim",
      projectId: "proj-a",
      principalId: "broker-1",
    }).ok,
  ).toBe(false);
  expect(
    verifyCapability({
      hostKey,
      signed,
      now: "2026-08-28T00:01:00.000Z",
      purpose: "blob-write",
      projectId: "proj-b",
      principalId: "broker-1",
    }).ok,
  ).toBe(false);
});

test("revoked certificate serial is treated as revoked by the store port", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const store = new StaticIdentityStore({
    records: [
      {
        principalId: "runner-1",
        identityKind: "runner",
        certificateSerial: "cc01",
        spkiSha256: "dd".repeat(32),
        revokedAt: "2026-08-28T00:00:00.000Z",
        notAfter: "2099-01-01T00:00:00.000Z",
        audiences: ["runner"],
        ed25519PublicKey: publicKey,
      },
    ],
    grants: {},
  });
  const record = store.lookupBySerialAndSpki("cc01", "dd".repeat(32));
  expect(record?.revokedAt).toBe("2026-08-28T00:00:00.000Z");
});
