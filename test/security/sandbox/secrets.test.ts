import { expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  generateEphemeralX25519,
  redactSecretMaterial,
  sealSecretToRecipient,
} from "../../../packages/sandbox/src/index.js";
import {
  startSecretBroker,
  verifyGrant,
} from "../../../apps/secret-broker/src/index.js";
import {
  CANARY,
  OP,
  PROJ,
  RUN,
  RUNNER,
  TS,
  keyBundle,
  makeGrant,
  signPayload,
  toJsonValue,
} from "./fixtures.js";

function injectFields() {
  const grant = makeGrant();
  return {
    targetRunnerId: RUNNER,
    targetProcessDigest: grant.targetProcessDigest,
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    destination: grant.destination,
    permittedNetworkDestinations: [] as const,
  };
}

test("secret canary never appears in broker envelopes or redacted artifacts", async () => {
  const authority = keyBundle("capability-authority");
  const runner = generateEphemeralX25519();
  const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-test-${randomBytes(8).toString("hex")}`;
  const broker = await startSecretBroker({
    endpoint: pipe,
    now: () => TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    secrets: new Map([["secret-canary", Buffer.from(CANARY, "utf8")]]),
  });
  try {
    const grant = makeGrant();
    const envelope = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
    const sealed = await broker.inject({
      grantEnvelope: envelope,
      ephemeralX25519PublicKey: runner.publicKeyRaw,
      ...injectFields(),
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) {
      return;
    }
    const wire = JSON.stringify(sealed.sealed);
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain(Buffer.from(CANARY, "utf8").toString("base64"));
    expect(wire).not.toContain(Buffer.from(CANARY, "utf8").toString("hex"));
    const logs = Buffer.from(`started\n${CANARY}\n${Buffer.from(CANARY, "utf8").toString("base64")}\n`);
    const redacted = redactSecretMaterial(logs, [Buffer.from(CANARY, "utf8")]);
    const redactedText = Buffer.from(redacted).toString("utf8");
    expect(redactedText).not.toContain(CANARY);
    expect(redactedText).not.toContain(Buffer.from(CANARY, "utf8").toString("base64"));
  } finally {
    await broker.close();
  }
});

test("grant replay fails closed", async () => {
  const authority = keyBundle("capability-authority");
  const runner = generateEphemeralX25519();
  const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-test-${randomBytes(8).toString("hex")}`;
  const broker = await startSecretBroker({
    endpoint: pipe,
    now: () => TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    secrets: new Map([["secret-canary", Buffer.from(CANARY, "utf8")]]),
  });
  try {
    const grant = makeGrant();
    const envelope = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
    const request = {
      grantEnvelope: envelope,
      ephemeralX25519PublicKey: runner.publicKeyRaw,
      ...injectFields(),
    };
    const first = await broker.inject(request);
    const second = await broker.inject(request);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("nonce-replay");
    }
  } finally {
    await broker.close();
  }
});

test("attestation mismatch fails closed", async () => {
  const authority = keyBundle("capability-authority");
  const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-test-${randomBytes(8).toString("hex")}`;
  const broker = await startSecretBroker({
    endpoint: pipe,
    now: () => TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    secrets: new Map([["secret-canary", Buffer.from(CANARY, "utf8")]]),
  });
  try {
    const grant = makeGrant();
    const envelope = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
    const other = generateEphemeralX25519();
    const denied = await broker.inject({
      grantEnvelope: envelope,
      targetRunnerId: "other-runner",
      targetProcessDigest: grant.targetProcessDigest,
      ephemeralX25519PublicKey: other.publicKeyRaw,
      projectId: PROJ,
      runId: RUN,
      operationId: OP,
      destination: grant.destination,
      permittedNetworkDestinations: [],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("attestation-mismatch");
    }
  } finally {
    await broker.close();
  }
});

test("grant for another project fails closed", async () => {
  const authority = keyBundle("capability-authority");
  const runner = generateEphemeralX25519();
  const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-test-${randomBytes(8).toString("hex")}`;
  const broker = await startSecretBroker({
    endpoint: pipe,
    now: () => TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    secrets: new Map([["secret-canary", Buffer.from(CANARY, "utf8")]]),
  });
  try {
    const grant = makeGrant();
    const envelope = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
    const denied = await broker.inject({
      grantEnvelope: envelope,
      ephemeralX25519PublicKey: runner.publicKeyRaw,
      ...injectFields(),
      projectId: "other-project",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("attestation-mismatch");
    }
  } finally {
    await broker.close();
  }
});

test("verifyGrant rejects extra properties and expiry/network/destination mismatch", () => {
  const authority = keyBundle("capability-authority");
  const grant = makeGrant();
  const expectedBase = {
    targetRunnerId: RUNNER,
    targetProcessDigest: grant.targetProcessDigest,
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    destination: grant.destination,
    permittedNetworkDestinations: [] as const,
  };
  const extra = signPayload(
    "SecretInjectionGrant",
    { ...toJsonValue(grant), extra: true },
    authority,
    TS,
  );
  const extraResult = verifyGrant({
    envelope: extra,
    now: TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    consumedNonces: new Set<string>(),
    expected: expectedBase,
  });
  expect(extraResult.ok).toBe(false);

  const expired = signPayload(
    "SecretInjectionGrant",
    toJsonValue(makeGrant({ expiresAt: "2026-08-27T00:00:00.000Z" })),
    authority,
    TS,
  );
  const expiredResult = verifyGrant({
    envelope: expired,
    now: TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    consumedNonces: new Set<string>(),
    expected: expectedBase,
  });
  expect(expiredResult.ok).toBe(false);

  const net = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
  const netResult = verifyGrant({
    envelope: net,
    now: TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    consumedNonces: new Set<string>(),
    expected: {
      ...expectedBase,
      permittedNetworkDestinations: ["api.example.com"],
    },
  });
  expect(netResult.ok).toBe(false);

  const dest = signPayload("SecretInjectionGrant", toJsonValue(grant), authority, TS);
  const destResult = verifyGrant({
    envelope: dest,
    now: TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    consumedNonces: new Set<string>(),
    expected: {
      ...expectedBase,
      destination: { kind: "file", relativePath: "secrets/canary", mode: "0400" },
    },
  });
  expect(destResult.ok).toBe(false);
  if (!destResult.ok) {
    expect(destResult.reason).toBe("destination-mismatch");
  }
});

test("sealSecretToRecipient never embeds plaintext", () => {
  const recipient = generateEphemeralX25519();
  const sealed = sealSecretToRecipient(Buffer.from(CANARY, "utf8"), recipient.publicKeyRaw);
  const json = JSON.stringify(sealed);
  expect(json).not.toContain(CANARY);
  expect(json).not.toContain(Buffer.from(CANARY, "utf8").toString("base64"));
});

test("secret-broker pipe processes one frame at a time", async () => {
  const authority = keyBundle("capability-authority");
  const runner = generateEphemeralX25519();
  const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-test-${randomBytes(8).toString("hex")}`;
  const broker = await startSecretBroker({
    endpoint: pipe,
    now: () => TS,
    capabilityAuthorityPublicKey: authority.publicKey,
    secrets: new Map([
      ["secret-canary", Buffer.from(CANARY, "utf8")],
      ["secret-second", Buffer.from("second-secret", "utf8")],
    ]),
  });
  const firstGrant = makeGrant();
  const secondGrant = makeGrant({
    grantId: "grant-canary-2",
    secretHandle: "secret-second",
    nonce: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  });
  const firstEnvelope = signPayload("SecretInjectionGrant", toJsonValue(firstGrant), authority, TS);
  const secondEnvelope = signPayload("SecretInjectionGrant", toJsonValue(secondGrant), authority, TS);
  const fields = injectFields();
  const encode = (grantEnvelope: unknown, destination: typeof firstGrant.destination) => {
    const body = Buffer.from(
      JSON.stringify({
        type: "inject",
        grantEnvelope,
        targetRunnerId: fields.targetRunnerId,
        targetProcessDigest: fields.targetProcessDigest,
        ephemeralX25519PublicKey: Buffer.from(runner.publicKeyRaw).toString("base64url"),
        permittedNetworkDestinations: [],
        projectId: fields.projectId,
        runId: fields.runId,
        operationId: fields.operationId,
        destination,
      }),
      "utf8",
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.byteLength);
    return Buffer.concat([header, body]);
  };
  const socket = net.connect(pipe);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        resolve();
      });
      socket.once("error", reject);
    });
    const replies: Buffer[] = [];
    socket.write(
      Buffer.concat([
        encode(firstEnvelope, firstGrant.destination),
        encode(secondEnvelope, secondGrant.destination),
      ]),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("pipe-frame-timeout"));
      }, 5_000);
      socket.on("data", (chunk: Buffer) => {
        replies.push(chunk);
        const joined = Buffer.concat(replies);
        if (joined.byteLength < 8) {
          return;
        }
        const firstSize = joined.readUInt32BE(0);
        if (joined.byteLength < 4 + firstSize + 4) {
          return;
        }
        const secondSize = joined.readUInt32BE(4 + firstSize);
        if (joined.byteLength < 4 + firstSize + 4 + secondSize) {
          return;
        }
        clearTimeout(timer);
        const a = JSON.parse(joined.subarray(4, 4 + firstSize).toString("utf8")) as { ok: boolean };
        const b = JSON.parse(
          joined.subarray(4 + firstSize + 4, 4 + firstSize + 4 + secondSize).toString("utf8"),
        ) as { ok: boolean };
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        resolve();
      });
    });
  } finally {
    socket.destroy();
    await broker.close();
  }
});
