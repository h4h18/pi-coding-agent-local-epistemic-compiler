import { access, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { toJsonValue, type SandboxJob, type SandboxJobResult } from "@pi-hec/contracts";
import {
  hypervisorBinaryAllowed,
  objectDigestOf,
  unknownResult,
  type ExecFilePort,
  type SandboxExecutionContext,
} from "../protocol.js";
import { defaultHypervisorExec } from "../qemu/overlay.js";
import {
  resolvePublicPins,
  startEgressProxy,
  type EgressProxyHandle,
} from "../qemu/egress-proxy.js";
import { listenComPipe } from "./com-pipe.js";
import {
  generateMetaData,
  generateNetworkConfig,
  generateUserData,
  recipeRequiresOci,
} from "./guest-agent.js";
import { formatInjectLine, unsealInjections } from "./inject.js";
import {
  buildDifferencingVhdPlan,
  ensureInternalSwitchCommands,
  GUEST_FABRIC_IP,
  hypervCreateCommands,
  hypervProxyAclCommands,
  hypervTeardownCommands,
  INTERNAL_SWITCH_NAME,
  PROXY_HOST_IP,
  PROXY_PORT,
} from "./image-flow.js";
import { comPipePath, sandboxVmName } from "./names.js";
import { resultFromGuestFrame } from "./result.js";
import { createNocloudSeedVhdx } from "./seed.js";

const MIN_BOOT_MEMORY = 512 * 1024 * 1024;
const MAX_BOOT_MEMORY = 1024 * 1024 * 1024;
const BOOT_WAIT_BUDGET_MS = 120_000;

const REAP_SCRIPT = [
  "Get-VM | Where-Object { $_.Name -like 'pi-hec-sb-*' } | ForEach-Object {",
  "  Stop-VM -VM $_ -TurnOff -Force -ErrorAction SilentlyContinue",
  "  Remove-VM -VM $_ -Force -ErrorAction SilentlyContinue",
  "}",
].join(" ");

export { sandboxVmName };

export async function reapPiHecSandboxVms(
  exec: ExecFilePort = defaultHypervisorExec,
): Promise<void> {
  try {
    await exec("powershell.exe", ["-NoLogo", "-NonInteractive", "-Command", REAP_SCRIPT], {
      timeout: 60_000,
    });
  } catch {
    // Best-effort reap; leftover disks are removed below.
  }
  const dir = tmpdir();
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("pi-hec-sb-"))
      .map((name) => rm(path.join(dir, name), { force: true, recursive: true })),
  );
}

function execErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & { stderr?: string; stdout?: string };
    return [extra.message, extra.stderr, extra.stdout]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n");
  }
  return "hyperv-boot-failed";
}

async function runPowerShell(
  exec: ExecFilePort,
  command: string,
  timeout = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return exec("powershell.exe", ["-NoLogo", "-NonInteractive", "-Command", command], { timeout });
}

function bootMemoryBytes(requested: number): number {
  return Math.min(MAX_BOOT_MEMORY, Math.max(MIN_BOOT_MEMORY, requested));
}

export async function bootHyperVJob(input: {
  job: SandboxJob;
  context: SandboxExecutionContext;
  exec: ExecFilePort;
}): Promise<SandboxJobResult> {
  const { job, context, exec } = input;
  const identity = {
    projectId: job.projectId,
    runId: job.runId,
    operationId: job.operationId,
    leaseGeneration: job.leaseGeneration,
  };
  const jobDigest = objectDigestOf(toJsonValue(job));
  if (hypervisorBinaryAllowed(context.command.executablePath)) {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "refusing-to-confuse-job-with-hypervisor" },
      completedAt: context.now,
    });
  }
  const parentPath = context.image.path;
  try {
    await access(parentPath);
  } catch {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "capability-absent", missing: "windows-vm-image" },
      completedAt: context.now,
    });
  }
  const vmName = sandboxVmName(job.nonce);
  const pipePath = comPipePath(vmName);
  const childPath = path.join(tmpdir(), `${vmName}.vhdx`);
  const seedPath = path.join(tmpdir(), `${vmName}-seed.vhdx`);
  const stagingDir = path.join(tmpdir(), `${vmName}-seed-files`);
  const memoryBytes = bootMemoryBytes(context.safetyProfile.memoryBytes);
  const needsNetwork = context.networkDestinations.length > 0;
  const ociRequired = recipeRequiresOci(context.recipe.requiredCapabilities);
  let networkSwitch: string | undefined;
  const waiter = await listenComPipe(pipePath, vmName);
  const startedAt = new Date().toISOString();
  const wallStarted = Date.now();
  let proxy: EgressProxyHandle | undefined;
  try {
    if (needsNetwork) {
      try {
        for (const command of ensureInternalSwitchCommands(INTERNAL_SWITCH_NAME, PROXY_HOST_IP)) {
          const ensured = await runPowerShell(exec, command);
          const named = /HEC_SWITCH (.+)/.exec(ensured.stdout);
          if (named?.[1]?.trim() !== INTERNAL_SWITCH_NAME) {
            return unknownResult({
              identity,
              jobDigest,
              evidence: { reason: "sandbox-switch-missing" },
              completedAt: new Date().toISOString(),
            });
          }
          networkSwitch = INTERNAL_SWITCH_NAME;
        }
      } catch (error) {
        return unknownResult({
          identity,
          jobDigest,
          evidence: { reason: "sandbox-switch-missing", message: execErrorMessage(error) },
          completedAt: new Date().toISOString(),
        });
      }
      const pinnedIps =
        context.pinnedIps ??
        (await resolvePublicPins(context.networkDestinations, context.protocolCapabilities));
      let lastBind: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          proxy = await startEgressProxy({
            policy: {
              destinations: context.networkDestinations,
              protocolCapabilities: context.protocolCapabilities,
              pinnedIps,
            },
            listenHost: PROXY_HOST_IP,
            listenPort: PROXY_PORT,
          });
          lastBind = undefined;
          break;
        } catch (error) {
          lastBind = error;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          });
        }
      }
      if (proxy === undefined) {
        throw lastBind instanceof Error ? lastBind : new Error("egress-proxy-bind");
      }
    }
    const plan = {
      ...buildDifferencingVhdPlan({ parentPath, childPath, memoryBytes }),
      vmName,
      comPipePath: pipePath,
      seedPath,
      ...(networkSwitch !== undefined ? { networkSwitch } : {}),
    };
    await createNocloudSeedVhdx({
      seedPath,
      stagingDir,
      metaData: generateMetaData(vmName),
      userData: generateUserData({
        command: context.command,
        safety: context.safetyProfile,
        stdoutBytes: Math.min(context.safetyProfile.stdoutBytes, job.outputPolicy.stdoutBytes),
        stderrBytes: Math.min(context.safetyProfile.stderrBytes, job.outputPolicy.stderrBytes),
        ociRequired,
        ...(needsNetwork
          ? { network: { guestIp: GUEST_FABRIC_IP, hostIp: PROXY_HOST_IP, proxyPort: PROXY_PORT } }
          : {}),
      }),
      networkConfig: generateNetworkConfig(),
      exec,
    });
    const createCommands = hypervCreateCommands(plan);
    const startCommand = createCommands[createCommands.length - 1];
    if (startCommand === undefined) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "hyperv-boot-failed", message: "missing-start-vm" },
        completedAt: context.now,
      });
    }
    for (const command of createCommands.slice(0, -1)) {
      await runPowerShell(exec, command);
    }
    if (needsNetwork) {
      for (const command of hypervProxyAclCommands(vmName, PROXY_HOST_IP, PROXY_PORT)) {
        await runPowerShell(exec, command);
      }
    }
    const items = context.sealedSecrets ?? [];
    if (items.length > 0 && context.unsealPrivateKey === undefined) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "secret-unseal-key-missing" },
        completedAt: new Date().toISOString(),
      });
    }
    await runPowerShell(exec, startCommand);
    const ready = await waiter.waitReady(BOOT_WAIT_BUDGET_MS);
    if (!ready) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "guest-timeout", missing: "hec-ready" },
        completedAt: new Date().toISOString(),
      });
    }
    const injected =
      items.length > 0 && context.unsealPrivateKey !== undefined
        ? unsealInjections({ items, privateKey: context.unsealPrivateKey })
        : { text: "HEC_INJECT_BEGIN\nHEC_INJECT_END\n", zeroize: () => undefined };
    try {
      if (!waiter.sendInject(formatInjectLine(injected.text))) {
        return unknownResult({
          identity,
          jobDigest,
          evidence: { reason: "inject-pipe" },
          completedAt: new Date().toISOString(),
        });
      }
    } finally {
      injected.zeroize();
    }
    const elapsed = Date.now() - wallStarted;
    const remaining = Math.max(
      15_000,
      BOOT_WAIT_BUDGET_MS - elapsed + context.safetyProfile.wallClockMillis,
    );
    const frame = await waiter.wait(remaining);
    const completedAt = new Date().toISOString();
    if (frame !== undefined) {
      const ociInside = await context.backends.oci.probeInsideVm(
        { kind: "hyperv-guest", vmName },
        { ns: frame.ns },
      );
      if (!ociInside.available) {
        return unknownResult({
          identity,
          jobDigest,
          evidence: { reason: "oci-namespaces-unenforceable", missing: ociInside.missing },
          completedAt,
        });
      }
    }
    return resultFromGuestFrame({
      job,
      frame,
      safety: context.safetyProfile,
      stdoutLimit: Math.min(context.safetyProfile.stdoutBytes, job.outputPolicy.stdoutBytes),
      stderrLimit: Math.min(context.safetyProfile.stderrBytes, job.outputPolicy.stderrBytes),
      startedAt,
      completedAt,
      ociRequired,
      networkSentBytes: proxy?.stats.sent ?? 0,
      networkReceivedBytes: proxy?.stats.received ?? 0,
    });
  } catch (error) {
    const message = execErrorMessage(error);
    await writeFile(waiter.serialLogPath, `boot-error\n${message}\n`, "utf8").catch(
      () => undefined,
    );
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "hyperv-boot-failed", message },
      completedAt: context.now,
    });
  } finally {
    if (proxy !== undefined) {
      await proxy.close().catch(() => undefined);
    }
    for (const command of hypervTeardownCommands(vmName)) {
      try {
        await runPowerShell(exec, command);
      } catch {
        // Continue remaining teardown commands for this VM only.
      }
    }
    await waiter.close();
    await rm(childPath, { force: true });
    await rm(seedPath, { force: true });
    await rm(stagingDir, { force: true, recursive: true });
  }
}
