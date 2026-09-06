import { expect, test } from "vitest";
import type { EnvironmentRecipe } from "@pi-hec/contracts";
import {
  executeSandboxJob,
  guestEnvironment,
  QemuBackend,
  OciBackend,
  HyperVBackend,
  MacosBackend,
  type SandboxExecutionContext,
} from "../../../packages/sandbox/src/index.js";
import {
  DIGEST,
  OBJECT_DIGEST,
  RUNNER,
  TS,
  identityStore,
  keyBundle,
  makeCommand,
  makeJob,
  recordingExec,
  signPayload,
  toJsonValue,
} from "./fixtures.js";

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


test("guest environment never contains control credentials or CAS write API", async () => {
  const runner = keyBundle("runner-key");
  const control = keyBundle("control-key");
  const exec = recordingExec();
  const hostEnv = {
    CONTROL_PLANE_CLIENT_KEY: "control-private-key-material",
    CAS_WRITE_TOKEN: "cas-write-secret",
    HTTP_PROXY: "http://127.0.0.1:8080",
    HTTPS_PROXY: "http://127.0.0.1:8080",
    ALL_PROXY: "socks5://127.0.0.1:1080",
    PATH: "C:\\\\Windows\\\\system32",
  };
  const env = guestEnvironment({
    platform: "linux",
    commandEnvironment: { LANG: "C.UTF-8" },
    hostEnvironment: hostEnv,
  });
  expect(env.CONTROL_PLANE_CLIENT_KEY).toBeUndefined();
  expect(env.CAS_WRITE_TOKEN).toBeUndefined();
  expect(env.HTTP_PROXY).toBeUndefined();
  expect(env.HTTPS_PROXY).toBeUndefined();
  expect(env.ALL_PROXY).toBeUndefined();
  expect(env.PATH).not.toBe(hostEnv.PATH);
  expect(JSON.stringify(env)).not.toContain("control-private-key-material");
  expect(JSON.stringify(env)).not.toContain("cas-write-secret");

  const ctx: SandboxExecutionContext = {
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
    recipe: recipe(),
    command: makeCommand("/usr/bin/true"),
    safetyProfile: {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    networkDestinations: [],
    protocolCapabilities: new Set<string>(),
    image: { platform: "linux", digest: OBJECT_DIGEST, path: "", provenancePath: "" },
    backends: {
      qemu: new QemuBackend(exec),
      oci: new OciBackend(),
      hyperv: new HyperVBackend(exec),
      macos: new MacosBackend(),
    },
  };
  const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(makeJob()), control, TS), ctx);
  const serialized = JSON.stringify(signed);
  expect(serialized).not.toContain("control-private-key-material");
  expect(serialized).not.toContain("cas-write-secret");
  expect(serialized).not.toContain("CAS_WRITE_TOKEN");
});
