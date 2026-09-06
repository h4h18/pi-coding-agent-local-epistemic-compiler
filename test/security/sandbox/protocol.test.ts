import { Compile } from "typebox/compile";
import { expect, test } from "vitest";
import {
  SandboxJobResultSchema,
  SandboxJobSchema,
  type EnvironmentRecipe,
} from "@pi-hec/contracts";
import { StaticIdentityStore } from "@pi-hec/security";
import {
  executeSandboxJob,
  REASON,
  type RecordingExec,
  type SandboxExecutionContext,
  QemuBackend,
  OciBackend,
  HyperVBackend,
  MacosBackend,
} from "../../../packages/sandbox/src/index.js";
import {
  DIGEST,
  OBJECT_DIGEST,
  OP,
  PROJ,
  RUN,
  RUNNER,
  TS,
  TS_EXPIRED,
  identityStore,
  keyBundle,
  makeCommand,
  makeJob,
  recordingExec,
  signPayload,
  toJsonObject,
  toJsonValue,
} from "./fixtures.js";

function recipe(platform: EnvironmentRecipe["platform"] = "linux"): EnvironmentRecipe {
  return {
    schemaVersion: 1,
    platform,
    architecture: "x86_64",
    requiredCapabilities: [],
    source: "project-hec-config",
    setupCommands: [],
    verificationCommands: [],
    networkPhases: [],
    writableRoots: ["out"],
    secretHandles: [],
    devices: [],
    resourceSafetyProfile: "default",
  };
}

function context(
  runner = keyBundle("runner-key"),
  control = keyBundle("control-key"),
  exec: RecordingExec = recordingExec(),
): {
  ctx: SandboxExecutionContext;
  runner: ReturnType<typeof keyBundle>;
  control: ReturnType<typeof keyBundle>;
  exec: RecordingExec;
} {
  const qemu = new QemuBackend(exec);
  return {
    runner,
    control,
    exec,
    ctx: {
      now: TS,
      runnerId: RUNNER,
      runnerPrivateKey: runner.privateKey,
      runnerCertificateDigest: runner.certDigest,
      runnerCertificateSerial: "aa05",
      controlPublicKey: control.publicKey,
      identityStore: identityStore(runner),
      consumedJobNonces: new Set<string>(),
      currentLeaseGeneration: 1,
      expectedInputRoot: DIGEST,
      expectedImageDigest: OBJECT_DIGEST,
      recipe: recipe("linux"),
      command: makeCommand("/usr/bin/true"),
      safetyProfile: {
        cpuMillis: 10_000,
        memoryBytes: 64 * 1024 * 1024,
        processCount: 32,
        diskBytes: 32 * 1024 * 1024,
        wallClockMillis: 15_000,
        stdoutBytes: 4096,
        stderrBytes: 4096,
      },
      networkDestinations: [],
      protocolCapabilities: new Set<string>(),
      image: {
        platform: "linux",
        digest: OBJECT_DIGEST,
        path: "",
        provenancePath: "",
      },
      backends: {
        qemu,
        oci: new OciBackend(),
        hyperv: new HyperVBackend(exec),
        macos: new MacosBackend(),
      },
    },
  };
}

test("signed SandboxJob extra properties are rejected", async () => {
  const { ctx, control } = context();
  const job = makeJob();
  const payload = { ...toJsonObject(job), extra: true };
  const envelope = signPayload("SandboxJob", payload, control, TS);
  expect(Compile(SandboxJobSchema).Check(payload)).toBe(false);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.extraProperties);
    expect(signed.envelope.payload.projectId).toBe(PROJ);
    expect(signed.envelope.payload.runId).toBe(RUN);
    expect(signed.envelope.payload.operationId).toBe(OP);
  }
});

test("signed SandboxJobResult extra properties are rejected by schema", () => {
  const valid = {
    schemaVersion: 1,
    outcome: "OUTCOME_UNKNOWN" as const,
    projectId: PROJ,
    runId: RUN,
    operationId: OP,
    leaseGeneration: 1,
    sandboxJobObjectDigest: OBJECT_DIGEST,
    lastEvidenceObjectDigest: OBJECT_DIGEST,
    completedAt: TS,
  };
  expect(Compile(SandboxJobResultSchema).Check(valid)).toBe(true);
  expect(Compile(SandboxJobResultSchema).Check({ ...valid, extra: true })).toBe(false);
});

test("signed SandboxJob round-trip yields attested result envelope", async () => {
  const { ctx, control } = context();
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(Compile(SandboxJobResultSchema).Check(signed.envelope.payload)).toBe(true);
  expect(signed.envelope.schemaName).toBe("SandboxJobResult");
  expect(signed.envelope.signatures).toHaveLength(1);
  expect(signed.attestation.jobNonce).toBe(makeJob().nonce);
  expect(signed.envelope.payload.projectId).toBe(PROJ);
});

test("expiry mismatch fails closed", async () => {
  const { ctx, control } = context();
  ctx.now = "2026-08-28T00:05:00.000Z";
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.expired);
  }
});

test("issued-in-the-future job is rejected as expired window", async () => {
  const { ctx, control } = context();
  const envelope = signPayload(
    "SandboxJob",
    toJsonValue(
      makeJob({ issuedAt: "2026-08-28T00:10:00.000Z", expiresAt: "2026-08-28T00:12:00.000Z" }),
    ),
    control,
    TS,
  );
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.expired);
  }
});

test("nonce reuse fails closed", async () => {
  const { ctx, control } = context();
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const first = await executeSandboxJob(envelope, ctx);
  const second = await executeSandboxJob(envelope, ctx);
  expect(first.envelope.payload.outcome).not.toBe("REJECTED");
  expect(second.envelope.payload.outcome).toBe("REJECTED");
  if (second.envelope.payload.outcome === "REJECTED") {
    expect(second.envelope.payload.reasonCode).toBe(REASON.nonceReplay);
  }
});

test("lease generation mismatch fails closed", async () => {
  const { ctx, control } = context();
  ctx.currentLeaseGeneration = 2;
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.leaseMismatch);
  }
});

test("audience mismatch fails closed", async () => {
  const { ctx, control } = context();
  const envelope = signPayload(
    "SandboxJob",
    toJsonValue(makeJob({ targetRunnerId: "other-runner" })),
    control,
    TS,
  );
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.audienceMismatch);
  }
});

test("missing project grant fails closed", async () => {
  const { ctx, control, runner } = context();
  ctx.identityStore = new StaticIdentityStore({
    records: [
      {
        principalId: RUNNER,
        identityKind: "runner",
        certificateSerial: "aa05",
        spkiSha256: runner.certDigest.slice("sha256:".length),
        revokedAt: undefined,
        notAfter: "2099-01-01T00:00:00.000Z",
        audiences: ["runner"],
        ed25519PublicKey: runner.publicKey,
      },
    ],
    grants: { [RUNNER]: [] },
    projects: [],
  });
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.grantMissing);
  }
});

test("image digest mismatch fails closed", async () => {
  const { ctx, control } = context();
  ctx.expectedImageDigest = `sha256:${"cd".repeat(32)}` as typeof OBJECT_DIGEST;
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.imageDigestMismatch);
  }
});

test("input root mismatch fails closed", async () => {
  const { ctx, control } = context();
  ctx.expectedInputRoot = `sha256:${"ef".repeat(32)}` as typeof DIGEST;
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.inputRootMismatch);
  }
});

test("invalid control signature fails closed", async () => {
  const { ctx, control, runner } = context();
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), runner, TS);
  expect(control.keyId).not.toBe(runner.keyId);
  ctx.controlPublicKey = control.publicKey;
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.signatureInvalid);
  }
});

test("expired-before-issue timestamps fail closed", async () => {
  const { ctx, control } = context();
  const envelope = signPayload(
    "SandboxJob",
    toJsonValue(makeJob({ issuedAt: TS, expiresAt: TS_EXPIRED })),
    control,
    TS,
  );
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.expired);
  }
});

test("revoked runner certificate fails closed", async () => {
  const { ctx, control, runner } = context();
  ctx.identityStore = identityStore(runner, true);
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.envelope.payload.outcome).toBe("REJECTED");
  if (signed.envelope.payload.outcome === "REJECTED") {
    expect(signed.envelope.payload.reasonCode).toBe(REASON.grantMissing);
  }
});

test("attestation expiresAt is strictly after issuedAt", async () => {
  const { ctx, control } = context();
  const envelope = signPayload("SandboxJob", toJsonValue(makeJob()), control, TS);
  const signed = await executeSandboxJob(envelope, ctx);
  expect(signed.attestation.expiresAt > signed.attestation.issuedAt).toBe(true);
  expect(Date.parse(signed.attestation.expiresAt)).toBeGreaterThan(
    Date.parse(signed.attestation.issuedAt),
  );
});
