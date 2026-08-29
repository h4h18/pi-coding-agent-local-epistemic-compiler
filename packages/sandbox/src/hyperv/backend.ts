import { access } from "node:fs/promises";
import {
  asExecPort,
  objectDigestOf,
  toJsonValue,
  unknownResult,
  type CapabilityProbe,
  type HypervisorExec,
  type SandboxBackend,
  type SandboxExecutionContext,
  type SandboxImageRef,
} from "../protocol.js";
import type { SandboxJob, SandboxJobResult } from "@pi-hec/contracts";
import { defaultHypervisorExec } from "../qemu/overlay.js";
import { bootHyperVJob } from "./boot.js";
import { HYPERV_PROBE_SCRIPT, selectWindowsIsolation } from "./image-flow.js";

export class HyperVBackend implements SandboxBackend {
  readonly #exec;

  constructor(exec: HypervisorExec = defaultHypervisorExec) {
    this.#exec = exec;
  }

  async probe(image: SandboxImageRef): Promise<CapabilityProbe> {
    if (image.path.length === 0) {
      return { available: false, missing: "windows-vm-image" };
    }
    try {
      await access(image.path);
    } catch {
      return { available: false, missing: "windows-vm-image" };
    }
    if (process.platform !== "win32") {
      return { available: false, missing: "hyperv" };
    }
    const exec = asExecPort(this.#exec);
    try {
      const result = await exec("powershell.exe", ["-NoLogo", "-NonInteractive", "-Command", HYPERV_PROBE_SCRIPT]);
      if (!/running/i.test(result.stdout)) {
        return { available: false, missing: "hyperv" };
      }
      return { available: true };
    } catch {
      return { available: false, missing: "hyperv" };
    }
  }

  async run(job: SandboxJob, context: SandboxExecutionContext): Promise<SandboxJobResult> {
    const identity = {
      projectId: job.projectId,
      runId: job.runId,
      operationId: job.operationId,
      leaseGeneration: job.leaseGeneration,
    };
    const jobDigest = objectDigestOf(toJsonValue(job));
    const isolation = selectWindowsIsolation("hyperv");
    if (!isolation.ok) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: isolation.reason },
        completedAt: context.now,
      });
    }
    const probe = await this.probe(context.image);
    if (!probe.available) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: probe.missing },
        completedAt: context.now,
      });
    }
    return bootHyperVJob({ job, context, exec: asExecPort(this.#exec) });
  }
}
