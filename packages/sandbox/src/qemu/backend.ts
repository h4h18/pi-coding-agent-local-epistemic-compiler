import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toJsonValue, type SandboxJob, type SandboxJobResult } from "@pi-hec/contracts";
import {
  asExecPort,
  hypervisorBinaryAllowed,
  objectDigestOf,
  unknownResult,
  type CapabilityProbe,
  type HypervisorExec,
  type SandboxBackend,
  type SandboxExecutionContext,
  type SandboxImageRef,
} from "../protocol.js";
import {
  createQcow2Overlay,
  defaultHypervisorExec,
  overlayPathFor,
  probeQemu,
  qemuKernelArgv,
  qemuNoNetworkArgv,
} from "./overlay.js";

export class QemuBackend implements SandboxBackend {
  readonly #exec;

  constructor(exec: HypervisorExec = defaultHypervisorExec) {
    this.#exec = exec;
  }

  async probe(image: SandboxImageRef): Promise<CapabilityProbe> {
    return probeQemu(asExecPort(this.#exec), image.path);
  }

  async run(job: SandboxJob, context: SandboxExecutionContext): Promise<SandboxJobResult> {
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
    const probe = await this.probe(context.image);
    if (!probe.available) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: probe.missing },
        completedAt: context.now,
      });
    }
    const exec = asExecPort(this.#exec);
    const initrdPath = path.join(path.dirname(context.image.path), "initramfs-virt");
    try {
      await access(initrdPath);
      await exec("qemu-system-x86_64", qemuKernelArgv(context.image.path, initrdPath, 512), {
        timeout: 8_000,
      });
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: "guest-agent" },
        completedAt: context.now,
      });
    } catch {
      // Netboot pair absent or qemu failed to boot it; try a qcow2 overlay next.
    }
    const overlay = overlayPathFor(job.nonce, tmpdir());
    const created = await createQcow2Overlay({
      backingFile: context.image.path,
      overlayPath: overlay,
      exec: this.#exec,
    });
    if (!created.ok) {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: created.missing },
        completedAt: context.now,
      });
    }
    try {
      await exec("qemu-system-x86_64", qemuNoNetworkArgv(created.overlayPath, 512), { timeout: 8_000 });
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: "guest-agent" },
        completedAt: context.now,
      });
    } catch {
      return unknownResult({
        identity,
        jobDigest,
        evidence: { reason: "capability-absent", missing: "qemu-boot" },
        completedAt: context.now,
      });
    } finally {
      await rm(created.overlayPath, { force: true });
    }
  }
}
