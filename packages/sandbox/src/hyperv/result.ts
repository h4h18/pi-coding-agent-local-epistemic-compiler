import { Compile } from "typebox/compile";
import { objectDigestFromBytes, SandboxJobResultSchema, type SandboxJob, type SandboxJobResult } from "@pi-hec/contracts";
import {
  boundOutput,
  evaluateSafety,
  objectDigestOf,
  sandboxOutputTreeDigest,
  toJsonValue,
  unknownResult,
  type SafetyProfile,
} from "../protocol.js";
import type { GuestFrame } from "./com-pipe.js";

const resultValidator = Compile(SandboxJobResultSchema);

function identityOf(job: SandboxJob) {
  return {
    projectId: job.projectId,
    runId: job.runId,
    operationId: job.operationId,
    leaseGeneration: job.leaseGeneration,
  };
}

export function resultFromGuestFrame(input: {
  job: SandboxJob;
  frame: GuestFrame | undefined;
  safety: SafetyProfile;
  stdoutLimit: number;
  stderrLimit: number;
  startedAt: string;
  completedAt: string;
  ociRequired: boolean;
  networkSentBytes: number;
  networkReceivedBytes: number;
}): SandboxJobResult {
  const identity = identityOf(input.job);
  const jobDigest = objectDigestOf(toJsonValue(input.job));
  if (input.frame === undefined) {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "guest-timeout" },
      completedAt: input.completedAt,
    });
  }
  if (input.frame.priv === 0 || input.frame.ulimit === 0) {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "privilege-or-ulimit-unenforceable" },
      completedAt: input.completedAt,
    });
  }
  if (input.frame.ns === 0) {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "oci-namespaces-unenforceable" },
      completedAt: input.completedAt,
    });
  }
  let stdout: Uint8Array;
  let stderr: Uint8Array;
  try {
    stdout = Buffer.from(input.frame.out, "base64");
    stderr = Buffer.from(input.frame.err, "base64");
  } catch {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "guest-frame-invalid" },
      completedAt: input.completedAt,
    });
  }
  const boundedOut = boundOutput(stdout, input.stdoutLimit);
  const boundedErr = boundOutput(stderr, input.stderrLimit);
  const usage = {
    cpuMillis: 0,
    peakMemoryBytes: 0,
    peakProcessCount: Math.max(0, input.frame.nproc),
    writtenBytes: Math.max(0, input.frame.wrote),
    networkSentBytes: Math.max(0, input.networkSentBytes),
    networkReceivedBytes: Math.max(0, input.networkReceivedBytes),
    wallClockMillis: 0,
  };
  const timedOut =
    input.frame.term === "SAFETY_LIMIT" &&
    (input.frame.ec === 124 || input.frame.ec === 137 || input.frame.ec === 143);
  const safety = evaluateSafety(
    {
      ...usage,
      wallClockMillis: timedOut ? input.safety.wallClockMillis + 1 : 0,
    },
    input.safety,
    timedOut,
  );
  let termination: GuestFrame["term"] = input.frame.term;
  switch (input.frame.term) {
    case "EXITED":
    case "SIGNALLED":
    case "SAFETY_LIMIT":
      termination = input.frame.term;
      break;
    default: {
      const exhaustive: never = input.frame.term;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
  if (safety === "safety-limit" || safety === "timeout") {
    termination = "SAFETY_LIMIT";
  }
  const result: SandboxJobResult = {
    schemaVersion: 1,
    outcome: "COMPLETED",
    projectId: input.job.projectId,
    runId: input.job.runId,
    operationId: input.job.operationId,
    leaseGeneration: input.job.leaseGeneration,
    sandboxJobObjectDigest: jobDigest,
    exitCode: input.frame.ec,
    termination,
    stdoutObjectDigest: objectDigestFromBytes(boundedOut.bytes),
    stderrObjectDigest: objectDigestFromBytes(boundedErr.bytes),
    producedArtifactObjectDigests: [],
    observedOutputTreeDigest: sandboxOutputTreeDigest([]),
    resourceUsage: usage,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  };
  if (!resultValidator.Check(result)) {
    return unknownResult({
      identity,
      jobDigest,
      evidence: { reason: "completed-schema-invalid" },
      completedAt: input.completedAt,
    });
  }
  return result;
}
