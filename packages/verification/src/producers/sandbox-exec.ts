import { executeSandboxJob, type SandboxExecutionContext } from "@pi-hec/sandbox";
import type {
  ArtifactEnvelope,
  CommandSpec,
  JsonValue,
  MaybePromise,
  ObjectDigest,
  ResolvedCommandSpec,
  RunObservation,
} from "@pi-hec/contracts";

export type SandboxRunInput = {
  spec: CommandSpec;
  resolved: ResolvedCommandSpec;
  resolvedEnvelopeDigest: ObjectDigest;
  jobEnvelope: ArtifactEnvelope<JsonValue>;
  networkRequired: boolean;
};

export type SandboxCommandResult =
  | {
      outcome: "COMPLETED";
      exitCode: number;
      observations: readonly RunObservation[];
    }
  | {
      outcome: "OUTCOME_UNKNOWN";
      reason: string;
      observations: readonly RunObservation[];
    }
  | {
      outcome: "REJECTED";
      reason: string;
      observations: readonly RunObservation[];
    };

export type SandboxExecutor = {
  run(input: SandboxRunInput): MaybePromise<SandboxCommandResult>;
};

export function createSandboxExecutor(context: SandboxExecutionContext): SandboxExecutor {
  return {
    async run(input) {
      if (input.resolved.executablePath.length === 0) {
        return {
          outcome: "REJECTED",
          reason: "executable-not-resolved",
          observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
        };
      }
      if (!input.networkRequired && input.spec.network !== "NONE") {
        return {
          outcome: "OUTCOME_UNKNOWN",
          reason: "network-capability-unavailable",
          observations: [
            {
              attempt: 1,
              state: "ERROR",
              durationMs: 0,
            },
          ],
        };
      }
      const payload = input.jobEnvelope.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        payload.resolvedCommandSpecObjectDigest !== input.resolvedEnvelopeDigest
      ) {
        return {
          outcome: "REJECTED",
          reason: "resolved-digest-mismatch",
          observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
        };
      }
      const signed = await executeSandboxJob(input.jobEnvelope, context);
      const resultPayload = signed.envelope.payload;
      if (resultPayload.outcome === "COMPLETED") {
        const observation: RunObservation = {
          attempt: 1,
          state: resultPayload.exitCode === 0 ? "PASSED" : "FAILED",
          exitCode: resultPayload.exitCode,
          durationMs: resultPayload.resourceUsage.wallClockMillis,
          stdoutArtifact: resultPayload.stdoutObjectDigest,
          stderrArtifact: resultPayload.stderrObjectDigest,
        };
        return { outcome: "COMPLETED", exitCode: resultPayload.exitCode, observations: [observation] };
      }
      if (resultPayload.outcome === "REJECTED") {
        return {
          outcome: "REJECTED",
          reason: resultPayload.reasonCode,
          observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
        };
      }
      return {
        outcome: "OUTCOME_UNKNOWN",
        reason: "sandbox-outcome-unknown",
        observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
      };
    },
  };
}

export function networkCapabilityUnavailableExecutor(): SandboxExecutor {
  return {
    run(input) {
      if (input.resolved.executablePath.length === 0) {
        return {
          outcome: "OUTCOME_UNKNOWN",
          reason: "executable-not-resolved",
          observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
        };
      }
      if (input.spec.network !== "NONE" || input.networkRequired) {
        return {
          outcome: "OUTCOME_UNKNOWN",
          reason: "pi-hec-sb-net-unavailable",
          observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
        };
      }
      return {
        outcome: "OUTCOME_UNKNOWN",
        reason: "sandbox-not-configured",
        observations: [{ attempt: 1, state: "ERROR", durationMs: 0 }],
      };
    },
  };
}
