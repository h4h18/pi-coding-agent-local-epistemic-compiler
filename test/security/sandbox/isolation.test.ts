import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentRecipe } from "@pi-hec/contracts";
import {
  executeSandboxJob,
  evaluateSafety,
  boundOutput,
  generateUserData,
  hypervCreateCommands,
  hypervisorBinaryAllowed,
  seedCreateScript,
  QemuBackend,
  OciBackend,
  HyperVBackend,
  MacosBackend,
  type SandboxExecutionContext,
} from "../../../packages/sandbox/src/index.js";
import { parseGuestFrame } from "../../../packages/sandbox/src/hyperv/com-pipe.js";
import { resultFromGuestFrame } from "../../../packages/sandbox/src/hyperv/result.js";
import { formatInjectLine } from "../../../packages/sandbox/src/hyperv/inject.js";
import { ensureSandboxSwitchCommand, hypervProxyAclCommands } from "../../../packages/sandbox/src/hyperv/image-flow.js";
import { guestUnshareFlags } from "../../../packages/sandbox/src/oci/backend.js";
import {
  CANARY,
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

function recipe(platform: EnvironmentRecipe["platform"]): EnvironmentRecipe {
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


function harness(executablePath: string, platform: EnvironmentRecipe["platform"] = "linux") {
  const runner = keyBundle("runner-key");
  const control = keyBundle("control-key");
  const exec = recordingExec();
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
    recipe: recipe(platform),
    command: makeCommand(executablePath),
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
    image: { platform, digest: OBJECT_DIGEST, path: "", provenancePath: "" },
    backends: {
      qemu: new QemuBackend(exec),
      oci: new OciBackend(),
      hyperv: new HyperVBackend(exec),
      macos: new MacosBackend(),
    },
  };
  return { ctx, control, exec };
}

test("capability absence yields structured unknown not host command execution", async () => {
  const { ctx, control, exec } = harness("/bin/fork-bomb");
  const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(makeJob()), control, TS), ctx);
  expect(signed.envelope.payload.outcome).toBe("OUTCOME_UNKNOWN");
  if (signed.envelope.payload.outcome === "OUTCOME_UNKNOWN") {
    expect(signed.envelope.payload.lastEvidenceObjectDigest.startsWith("sha256:")).toBe(true);
  }
  expect(exec.calls.some((call) => call.file.includes("fork-bomb") || call.args.includes("/bin/fork-bomb"))).toBe(
    false,
  );
  expect(exec.calls.some((call) => !hypervisorBinaryAllowed(call.file))).toBe(false);
});

test("macos adapter fails closed with structured unknown on this host", async () => {
  const { ctx, control, exec } = harness("/usr/bin/true", "macos");
  const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(makeJob()), control, TS), ctx);
  expect(signed.envelope.payload.outcome).toBe("OUTCOME_UNKNOWN");
  expect(exec.calls).toEqual([]);
});

test("windows hyper-v adapter does not fall back to process isolation on the host", async () => {
  const { ctx, control, exec } = harness("C:\\\\Windows\\\\System32\\\\cmd.exe", "windows");
  const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(makeJob()), control, TS), ctx);
  expect(signed.envelope.payload.outcome).toBe("OUTCOME_UNKNOWN");
  expect(exec.calls.some((call) => call.args.includes("--isolation=process"))).toBe(false);
  expect(exec.calls.some((call) => call.file.toLowerCase().includes("cmd.exe"))).toBe(false);
});

test("rootless OCI refuses to run on the host", () => {
  const oci = new OciBackend();
  const probe = oci.probeInsideVm(undefined);
  expect(probe.available).toBe(false);
  if (!probe.available) {
    expect(probe.missing).toBe("trusted-vm");
  }
});

test("fork bomb safety profile trips without host PID namespace", () => {
  const decision = evaluateSafety(
    {
      cpuMillis: 10,
      peakMemoryBytes: 1024,
      peakProcessCount: 4096,
      writtenBytes: 0,
      networkSentBytes: 0,
      networkReceivedBytes: 0,
      wallClockMillis: 50,
    },
    {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    false,
  );
  expect(decision).toBe("safety-limit");
});

test("disk fill is bounded by safety profile", () => {
  const decision = evaluateSafety(
    {
      cpuMillis: 10,
      peakMemoryBytes: 1024,
      peakProcessCount: 1,
      writtenBytes: 1024 * 1024,
      networkSentBytes: 0,
      networkReceivedBytes: 0,
      wallClockMillis: 50,
    },
    {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    false,
  );
  expect(decision).toBe("safety-limit");
});

test("output flood is truncated by outputPolicy", () => {
  const flood = Buffer.alloc(4096, 0x41);
  const bounded = boundOutput(flood, 32);
  expect(bounded.bytes.byteLength).toBe(32);
  expect(bounded.truncated).toBe(true);
});

test("timeout does not fabricate a successful completed result", async () => {
  const { ctx, control } = harness("/bin/sleep");
  const signed = await executeSandboxJob(signPayload("SandboxJob", toJsonValue(makeJob()), control, TS), ctx);
  expect(signed.envelope.payload.outcome).not.toBe("COMPLETED");
});

test("hypervisor binary allowlist rejects untrusted executables", () => {
  expect(hypervisorBinaryAllowed("qemu-system-x86_64")).toBe(true);
  expect(hypervisorBinaryAllowed("qemu-img")).toBe(true);
  expect(hypervisorBinaryAllowed("powershell.exe")).toBe(true);
  expect(hypervisorBinaryAllowed("/bin/fork-bomb")).toBe(false);
  expect(hypervisorBinaryAllowed("cmd.exe")).toBe(false);
  expect(hypervisorBinaryAllowed("wsl.exe")).toBe(false);
});

test("guest agent never falls back to root and fail-closes ulimit", () => {
  const script = generateUserData({
    command: makeCommand("/bin/echo"),
    safety: {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    stdoutBytes: 32,
    stderrBytes: 32,
    ociRequired: true,
  });
  expect(script).toContain("unshare -U");
  expect(script).toContain("-p");
  expect(script).toContain("-f");
  expect(script).toContain("--mount-proc");
  expect(script).toContain("ulimit -c 0");
  expect(script).toContain("/tmp/fill");
  expect(script).not.toContain("nproc_now=1");
  expect(script).not.toMatch(/else\s+\$TO \/tmp\/hec-job\.sh/);
  expect(script).toContain("fail_unknown");
  expect(script).toContain("HEC_INJECT");
  expect(script).toContain("read -t");
  expect(script).not.toContain("CANARY");
});

test("guest always applies user and pid namespaces even without an OCI capability flag", () => {
  const script = generateUserData({
    command: makeCommand("/bin/echo"),
    safety: {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    stdoutBytes: 32,
    stderrBytes: 32,
  });
  expect(script).toContain(guestUnshareFlags(false));
  expect(script).toContain("fail_unknown ns");
});

test("seed VHD mount always dismounts in finally", () => {
  const script = seedCreateScript("C:\\\\tmp\\\\seed.vhdx", "C:\\\\tmp\\\\seed-files");
  expect(script).toMatch(/try\s*\{/);
  expect(script).toMatch(/finally\s*\{/);
  expect(script).toContain("Dismount-VHD");
});

test("rootless OCI probe requires guest ns evidence from the VM result", () => {
  const oci = new OciBackend();
  const session = { kind: "hyperv-guest" as const, vmName: "pi-hec-sb-test" };
  expect(oci.probeInsideVm(session).available).toBe(false);
  expect(oci.probeInsideVm(session, { ns: 0 }).available).toBe(false);
  const inside = oci.probeInsideVm(session, { ns: 1 });
  expect(inside.available).toBe(true);
  const host = oci.probeInsideVm(undefined, { ns: 1 });
  expect(host.available).toBe(false);
});

test("Hyper-V create plan disconnects NIC unless an internal switch is supplied", () => {
  const disconnected = hypervCreateCommands({
    isolation: "hyperv",
    parentPath: "C:\\\\parent.vhdx",
    childPath: "C:\\\\child.vhdx",
    generation: 2,
    network: "none",
    memoryBytes: 512 * 1024 * 1024,
    vmName: "pi-hec-sb-test",
    comPipePath: "\\\\.\\pipe\\pi-hec-sb-test",
    seedPath: "C:\\\\seed.vhdx",
  });
  expect(disconnected.some((command) => command.includes("Disconnect-VMNetworkAdapter"))).toBe(true);
  const connected = hypervCreateCommands({
    isolation: "hyperv",
    parentPath: "C:\\\\parent.vhdx",
    childPath: "C:\\\\child.vhdx",
    generation: 2,
    network: "none",
    memoryBytes: 512 * 1024 * 1024,
    vmName: "pi-hec-sb-test",
    comPipePath: "\\\\.\\pipe\\pi-hec-sb-test",
    seedPath: "C:\\\\seed.vhdx",
    networkSwitch: "pi-hec-sb-net",
  });
  expect(connected.some((command) => command.includes("Connect-VMNetworkAdapter"))).toBe(true);
  expect(connected.some((command) => command.includes("Disconnect-VMNetworkAdapter"))).toBe(false);
});

test("sandbox switch ensure never falls back to Default Switch or an arbitrary Internal switch", () => {
  const cmd = ensureSandboxSwitchCommand("pi-hec-sb-net", "10.255.254.1");
  expect(cmd).toContain("pi-hec-sb-net");
  expect(cmd).toContain("New-VMSwitch");
  expect(cmd).not.toContain("Default Switch");
  expect(cmd).not.toContain("Select-Object -First 1");
  expect(cmd).not.toMatch(/SwitchType\s+-eq\s+'Internal'/);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const boot = readFileSync(path.join(repo, "packages/sandbox/src/hyperv/boot.ts"), "utf8");
  expect(boot).not.toContain("Default Switch");
  const connected = hypervCreateCommands({
    isolation: "hyperv",
    parentPath: "C:\\\\parent.vhdx",
    childPath: "C:\\\\child.vhdx",
    generation: 2,
    network: "none",
    memoryBytes: 512 * 1024 * 1024,
    vmName: "pi-hec-sb-test",
    comPipePath: "\\\\.\\pipe\\pi-hec-sb-test",
    seedPath: "C:\\\\seed.vhdx",
    networkSwitch: "pi-hec-sb-net",
  });
  expect(connected.join("\n")).not.toContain("Default Switch");
});

test("Hyper-V proxy ACLs allow only TCP to the proxy listen port", () => {
  const acls = hypervProxyAclCommands("pi-hec-sb-test", "10.255.254.1", 3128);
  expect(acls.some((command) => command.includes("Add-VMNetworkAdapterExtendedAcl"))).toBe(true);
  expect(acls.some((command) => command.includes("RemotePort 3128") && command.includes("Allow"))).toBe(true);
  expect(acls.some((command) => command.includes("Action Deny") && command.includes("Outbound"))).toBe(true);
  expect(acls.every((command) => command.includes("pi-hec-sb-test"))).toBe(true);
});

test("truncated HEC_RESULT without priv/ns/ulimit is fail-closed", () => {
  const parsed = parseGuestFrame(
    '{"ec":0,"term":"EXITED","out":"","err":"","nproc":0,"wrote":0}',
  );
  expect(parsed).toBeDefined();
  expect(parsed?.priv).toBe(0);
  expect(parsed?.ns).toBe(0);
  expect(parsed?.ulimit).toBe(0);
  const signed = resultFromGuestFrame({
    job: makeJob(),
    frame: parsed,
    safety: {
      cpuMillis: 10_000,
      memoryBytes: 64 * 1024 * 1024,
      processCount: 8,
      diskBytes: 1024,
      wallClockMillis: 15_000,
      stdoutBytes: 32,
      stderrBytes: 32,
    },
    stdoutLimit: 32,
    stderrLimit: 32,
    startedAt: TS,
    completedAt: TS,
    ociRequired: false,
    networkSentBytes: 0,
    networkReceivedBytes: 0,
  });
  expect(signed.outcome).toBe("OUTCOME_UNKNOWN");
});

test("inject framing is one HEC_INJECT line and never embeds a canary", () => {
  const line = formatInjectLine(`HEC_INJECT_BEGIN\nENV CANARY_TOKEN ${Buffer.from(CANARY, "utf8").toString("base64")}\nHEC_INJECT_END\n`);
  expect(line.startsWith("HEC_INJECT ")).toBe(true);
  expect(line.endsWith("\n")).toBe(true);
  expect(line).not.toContain(CANARY);
  expect(formatInjectLine("HEC_INJECT_BEGIN\nHEC_INJECT_END\n")).toBe("HEC_INJECT\n");
});

test("Hyper-V job teardown targets one VM and QEMU does not start a proxy on nic none", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const boot = readFileSync(path.join(repo, "packages/sandbox/src/hyperv/boot.ts"), "utf8");
  expect(boot).not.toContain("await reapPiHecSandboxVms(exec)");
  expect(boot).toContain("hypervTeardownCommands(vmName)");
  expect(boot).toContain("sendInject");
  expect(boot).not.toContain("createFatFilesVhdx");
  const qemu = readFileSync(path.join(repo, "packages/sandbox/src/qemu/backend.ts"), "utf8");
  expect(qemu).not.toContain("startEgressProxy");
});
