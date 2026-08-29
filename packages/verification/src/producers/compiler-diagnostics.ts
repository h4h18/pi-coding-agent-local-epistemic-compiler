import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stderrText, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "compiler-diagnostics";

export type CompilerDiagnostic = {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note" | "fatal";
  message: string;
};

const GCC_CLANG =
  /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.+)$/;
const MSVC = /^(.+?)\((\d+)\)\s*:\s+(fatal error|error|warning)\s+[A-Z]?\d+:\s+(.+)$/;

export function parseCompilerDiagnostics(text: string): CompilerDiagnostic[] {
  const out: CompilerDiagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const gcc = GCC_CLANG.exec(raw);
    if (gcc !== null && gcc[1] !== undefined && gcc[2] !== undefined && gcc[3] !== undefined && gcc[4] !== undefined && gcc[5] !== undefined) {
      out.push({
        file: gcc[1],
        line: Number.parseInt(gcc[2], 10),
        column: Number.parseInt(gcc[3], 10),
        severity: parseSeverity(gcc[4]),
        message: gcc[5],
      });
      continue;
    }
    const msvc = MSVC.exec(raw);
    if (msvc !== null && msvc[1] !== undefined && msvc[2] !== undefined && msvc[3] !== undefined && msvc[4] !== undefined) {
      out.push({
        file: msvc[1],
        line: Number.parseInt(msvc[2], 10),
        column: 0,
        severity: parseSeverity(msvc[3]),
        message: msvc[4],
      });
    }
  }
  return out;
}

function parseSeverity(value: string): CompilerDiagnostic["severity"] {
  switch (value) {
    case "fatal error":
      return "fatal";
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "note":
      return "note";
    default:
      return "error";
  }
}

export function createCompilerDiagnosticsProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      void host.listPaths();
      return [capability(ID, ["unified-compiler-diagnostics"])];
    },
    async plan(obligation: ProofObligation) {
      if (obligation.kind !== "BUILD") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "compiler-diagnostics-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const text = `${stdoutText(last, artifacts)}\n${stderrText(last, artifacts)}`;
      const diagnostics = parseCompilerDiagnostics(text);
      if (diagnostics.length === 0 && last.exitCode === 0) {
        return [
          evidenceFromParse({
            check,
            observations,
            relation: "SUPPORTS",
            origin: "INDEPENDENT_TOOL",
            oracle: "EXPLICIT_EXPECTATION",
            producerId: ID,
            producerVersionObjectDigest: versionObjectDigest,
            bindings,
          }),
        ];
      }
      if (diagnostics.length === 0) {
        return [];
      }
      const failed = diagnostics.some((item) => item.severity === "error" || item.severity === "fatal");
      return [
        evidenceFromParse({
          check,
          observations,
          relation: failed ? "REFUTES" : "SUPPORTS",
          origin: "INDEPENDENT_TOOL",
          oracle: "EXPLICIT_EXPECTATION",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}
