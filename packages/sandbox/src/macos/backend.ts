import {
  objectDigestOf,
  unknownResult,
  type CapabilityProbe,
  type SandboxBackend,
  type SandboxExecutionContext,
  type SandboxImageRef,
} from "../protocol.js";
import { toJsonValue, type SandboxJob, type SandboxJobResult } from "@pi-hec/contracts";

export class MacosBackend implements SandboxBackend {
  probe(image: SandboxImageRef): CapabilityProbe {
    if (process.platform !== "darwin") {
      return { available: false, missing: "macos" };
    }
    if (image.path.length === 0) {
      return { available: false, missing: "macos-vm-image" };
    }
    return { available: false, missing: "macos-vm" };
  }

  run(job: SandboxJob, context: SandboxExecutionContext): Promise<SandboxJobResult> {
    const identity = {
      projectId: job.projectId,
      runId: job.runId,
      operationId: job.operationId,
      leaseGeneration: job.leaseGeneration,
    };
    const jobDigest = objectDigestOf(toJsonValue(job));
    const probe = this.probe(context.image);
    return Promise.resolve(
      unknownResult({
        identity,
        jobDigest,
        evidence: {
          reason: "capability-absent",
          missing: probe.available ? "macos-vm" : probe.missing,
        },
        completedAt: context.now,
      }),
    );
  }
}
