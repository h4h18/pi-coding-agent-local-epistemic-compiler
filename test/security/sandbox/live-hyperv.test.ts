import { createHash, randomBytes } from "node:crypto";
import { access, readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { objectDigestFromBytes, type EnvironmentRecipe, type ObjectDigest } from "@pi-hec/contracts";
import {
  CANARY,
  DIGEST,
  OP,
  PROJ,
  RUN,
  RUNNER,
  identityStore,
  keyBundle,
  makeCommand,
  makeGrant,
  makeJob,
  signPayload,
  toJsonValue,
} from "./fixtures.js";
import {
  executeSandboxJob,
  generateEphemeralX25519,
  HyperVBackend,
  MacosBackend,
  OciBackend,
  QemuBackend,
  reapPiHecSandboxVms,
  sandboxVmName,
  type SandboxExecutionContext,
} from "../../../packages/sandbox/src/index.js";
import { startSecretBroker } from "../../../apps/secret-broker/src/index.js";

const execFileAsync = promisify(execFile);
const LIVE_TIMEOUT = 180_000;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VHDX = path.join(repo, "deploy/sandbox-images/generic_alpine-3.24.1-x86_64-uefi-tiny-r0.vhdx");

function recipe(): EnvironmentRecipe {
  return {
    schemaVersion: 1,
    platform: "linux",
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

async function digestFile(filePath: string): Promise<ObjectDigest> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return `sha256:${hash.digest("hex")}` as ObjectDigest;
}

async function hostPidCount(): Promise<number> {
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NonInteractive", "-Command", "(Get-Process).Count"],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return Number.parseInt(result.stdout.trim(), 10);
}

async function dedicatedSandboxSwitchExists(): Promise<boolean> {
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NonInteractive",
      "-Command",
      "if (Get-VMSwitch -Name 'pi-hec-sb-net' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return result.stdout.trim() === "yes";
}

async function vmAdapterSwitchName(name: string): Promise<string> {
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NonInteractive",
      "-Command",
      `$vm = Get-VM -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue; if ($null -eq $vm) { 'none' } else { @((Get-VMNetworkAdapter -VM $vm).SwitchName) -join ',' }`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return result.stdout.trim();
}

async function vmExists(name: string): Promise<boolean> {
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NonInteractive",
      "-Command",
      `if (Get-VM -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  return result.stdout.trim() === "yes";
}

async function liveContext(executablePath: string, argv: string[]) {
  const runner = keyBundle("runner-key");
  const control = keyBundle("control-key");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  const nonce = randomBytes(32).toString("base64url");
  const digest = await digestFile(VHDX);
  const ctx: SandboxExecutionContext = {
    now,
    runnerId: RUNNER,
    runnerPrivateKey: runner.privateKey,
    runnerCertificateDigest: runner.certDigest,
    runnerCertificateSerial: "aa05",
    controlPublicKey: control.publicKey,
    identityStore: identityStore(runner),
    consumedJobNonces: new Set<string>(),
    currentLeaseGeneration: 1,
    expectedInputRoot: DIGEST,
    expectedImageDigest: digest,
    recipe: recipe(),
    command: { ...makeCommand(executablePath), argv },
    safetyProfile: {
      cpuMillis: 20_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024 * 1024,
      wallClockMillis: 20_000,
      stdoutBytes: 64,
      stderrBytes: 64,
    },
    networkDestinations: [],
    protocolCapabilities: new Set<string>(),
    image: {
      platform: "linux",
      digest,
      path: VHDX,
      provenancePath: path.join(path.dirname(VHDX), "provenance.json"),
    },
    backends: {
      qemu: new QemuBackend(),
      oci: new OciBackend(),
      hyperv: new HyperVBackend(),
      macos: new MacosBackend(),
    },
  };
  const job = makeJob({
    issuedAt: now,
    expiresAt: expires,
    nonce,
    sandboxImageObjectDigest: digest,
    outputPolicy: {
      stdoutBytes: 64,
      stderrBytes: 64,
      artifactBytes: 65536,
      allowedArtifactGlobs: ["out/**"],
    },
  });
  return { ctx, control, job, now, nonce, vmName: sandboxVmName(nonce) };
}

describe.sequential("live Hyper-V Gen2 guest", () => {
  beforeAll(async () => {
    await access(VHDX);
  }, LIVE_TIMEOUT);

  afterEach(async () => {
    await reapPiHecSandboxVms();
  }, 60_000);

  afterAll(async () => {
    await reapPiHecSandboxVms();
  }, 60_000);

  test(
    "echo completes inside the guest and the VM is gone",
    async () => {
      const { ctx, control, job, now, vmName } = await liveContext("/bin/echo", ["sandbox-ok"]);
      const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
      const payload = signed.envelope.payload;
      const serial = await readFile(path.join(os.tmpdir(), `${vmName}.serial.log`), "utf8").catch(() => "");
      expect(payload.outcome, serial.slice(-4000)).toBe("COMPLETED");
      if (payload.outcome === "COMPLETED") {
        expect(payload.exitCode, serial.slice(-800)).toBe(0);
        expect(payload.termination).toBe("EXITED");
        expect(payload.stdoutObjectDigest.startsWith("sha256:")).toBe(true);
        expect(serial).toMatch(/"ns":1/);
      }
      expect(await vmExists(vmName)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  test(
    "fork bomb is contained in the guest",
    async () => {
      const before = await hostPidCount();
      const { ctx, control, job, now, vmName } = await liveContext("/bin/sh", [
        "-c",
        "i=0; while [ $i -lt 200 ]; do /bin/sleep 30 & i=$((i+1)); done; wait",
      ]);
      const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
      const payload = signed.envelope.payload;
      expect(["COMPLETED", "OUTCOME_UNKNOWN"]).toContain(payload.outcome);
      if (payload.outcome === "COMPLETED") {
        expect(["SAFETY_LIMIT", "EXITED", "SIGNALLED"]).toContain(payload.termination);
        if (payload.termination === "EXITED") {
          expect(payload.exitCode).not.toBe(0);
        }
      }
      const after = await hostPidCount();
      expect(after - before).toBeLessThan(80);
      expect(await vmExists(vmName)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  test(
    "disk fill and output flood stay bounded",
    async () => {
      const diskBefore = await statfs("C:\\");
      const freeBefore = diskBefore.bavail * diskBefore.bsize;
      const { ctx, control, job, now, vmName } = await liveContext("/bin/sh", [
        "-c",
        "dd if=/dev/zero of=/tmp/fill bs=1024 count=4096 2>/dev/null; dd if=/dev/zero bs=1024 count=256",
      ]);
      const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
      const payload = signed.envelope.payload;
      expect(["COMPLETED", "OUTCOME_UNKNOWN"]).toContain(payload.outcome);
      if (payload.outcome === "COMPLETED") {
        expect(["SAFETY_LIMIT", "EXITED", "SIGNALLED"]).toContain(payload.termination);
      }
      const diskAfter = await statfs("C:\\");
      expect(diskAfter.bavail * diskAfter.bsize).toBeGreaterThan(freeBefore - 64 * 1024 * 1024);
      expect(await vmExists(vmName)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  test(
    "guest network to metadata DNS DoH LAN fails without host fallback",
    async () => {
      const { ctx, control, job, now, vmName } = await liveContext("/bin/sh", [
        "-c",
        "wget -q -T 2 -O- http://169.254.169.254/",
      ]);
      const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
      const payload = signed.envelope.payload;
      const serial = await readFile(path.join(os.tmpdir(), `${vmName}.serial.log`), "utf8").catch(() => "");
      expect(["COMPLETED", "OUTCOME_UNKNOWN"], serial.slice(-4000)).toContain(payload.outcome);
      if (payload.outcome === "COMPLETED") {
        expect(payload.exitCode).not.toBe(0);
      }
      expect(JSON.stringify(payload)).not.toContain("169.254.169.254");
      expect(await vmExists(vmName)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  test(
    "network capability jobs only reach the host proxy and count bytes",
    async () => {
      const { ctx, control, job, now, vmName } = await liveContext("/bin/sh", [
        "-c",
        "http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= wget -q -T 2 -O /dev/null http://10.255.254.1:80/; d=$?; wget -q -T 5 -O /dev/null http://example.com/; exit $d",
      ]);
      ctx.networkDestinations = ["example.com"];
      const dedicated = await dedicatedSandboxSwitchExists();
      const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
      const payload = signed.envelope.payload;
      const serial = await readFile(path.join(os.tmpdir(), `${vmName}.serial.log`), "utf8").catch(() => "");
      const nicSwitch = await vmAdapterSwitchName(vmName);
      expect(nicSwitch).not.toBe("Default Switch");
      if (dedicated) {
        expect(payload.outcome, serial.slice(-4000)).toBe("COMPLETED");
        if (payload.outcome === "COMPLETED") {
          expect(payload.exitCode).not.toBe(0);
          expect(payload.resourceUsage.networkSentBytes).toBeGreaterThan(0);
        }
      } else {
        expect(payload.outcome, serial.slice(-4000)).toBe("OUTCOME_UNKNOWN");
      }
      expect(JSON.stringify(payload)).not.toContain("169.254.169.254");
      expect(JSON.stringify(payload)).not.toContain("Default Switch");
      expect(await vmExists(vmName)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  test(
    "secret canary is injected after spawn and absent from live artifacts",
    async () => {
      const authority = keyBundle("capability-authority");
      const x25519 = generateEphemeralX25519();
      const pipe = `\\\\.\\pipe\\pi-hec-secret-broker-live-${randomBytes(8).toString("hex")}`;
      const broker = await startSecretBroker({
        endpoint: pipe,
        now: () => new Date().toISOString(),
        capabilityAuthorityPublicKey: authority.publicKey,
        secrets: new Map([["secret-canary", Buffer.from(CANARY, "utf8")]]),
      });
      try {
        const grant = makeGrant({
          nonce: randomBytes(32).toString("base64url"),
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        const envelope = signPayload(
          "SecretInjectionGrant",
          toJsonValue(grant),
          authority,
          grant.issuedAt,
        );
        const injected = await broker.inject({
          grantEnvelope: envelope,
          targetRunnerId: RUNNER,
          targetProcessDigest: grant.targetProcessDigest,
          ephemeralX25519PublicKey: x25519.publicKeyRaw,
          projectId: PROJ,
          runId: RUN,
          operationId: OP,
          destination: grant.destination,
          permittedNetworkDestinations: [],
        });
        expect(injected.ok).toBe(true);
        if (!injected.ok) {
          return;
        }
        const { ctx, control, job, now, vmName } = await liveContext("/bin/sh", [
          "-c",
          'test -n "$CANARY_TOKEN" && echo HAS_SECRET',
        ]);
        ctx.sealedSecrets = [{ destination: grant.destination, sealed: injected.sealed }];
        ctx.unsealPrivateKey = x25519.privateKey;
        const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(job), control, now), ctx);
        const encoded = JSON.stringify(signed);
        expect(encoded).not.toContain(CANARY);
        expect(signed.envelope.payload.outcome).toBe("COMPLETED");
        if (signed.envelope.payload.outcome === "COMPLETED") {
          expect(signed.envelope.payload.exitCode).toBe(0);
          expect(signed.envelope.payload.stdoutObjectDigest).toBe(
            objectDigestFromBytes(Buffer.from("HAS_SECRET\n")),
          );
        }
        expect(await vmExists(vmName)).toBe(false);
      } finally {
        await broker.close();
      }
    },
    LIVE_TIMEOUT,
  );
});
