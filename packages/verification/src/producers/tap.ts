import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "tap";

export type TapPoint = {
  ok: boolean;
  number: number | undefined;
  description: string;
  directive: "skip" | "todo" | undefined;
};

export function parseTap(text: string): { plan: number | undefined; points: TapPoint[] } {
  let plan: number | undefined;
  const points: TapPoint[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const planMatch = /^1\.\.(\d+)\s*$/.exec(line);
    if (planMatch !== null && planMatch[1] !== undefined) {
      plan = Number.parseInt(planMatch[1], 10);
      continue;
    }
    const point = /^(not )?ok(?:\s+(\d+))?(?:\s+-\s+(.*?)|\s+(.*?))?(?:\s+#\s*(SKIP|TODO|skip|todo)\b.*)?$/.exec(line);
    if (point === null) {
      continue;
    }
    const directiveRaw = point[5];
    let directive: TapPoint["directive"];
    if (directiveRaw !== undefined) {
      directive = directiveRaw.toLowerCase() === "skip" ? "skip" : "todo";
    }
    const description = point[3] ?? point[4] ?? "";
    const numberText = point[2];
    points.push({
      ok: point[1] === undefined,
      number: numberText === undefined ? undefined : Number.parseInt(numberText, 10),
      description,
      directive,
    });
  }
  return { plan, points };
}

export function createTapProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    probe() {
      if (!hostHasPath(host, (path) => path.endsWith(".tap") || path.endsWith(".t"))) {
        return [];
      }
      return [capability(ID, ["tap"])];
    },
    plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "FUNCTIONAL" && obligation.kind !== "REPRODUCTION") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "tap-parse", versionObjectDigest, "CANDIDATE")];
    },
    parse(check: CheckNode, observations: readonly RunObservation[]): readonly EvidenceRecord[] {
      const last = lastObservation(observations);
      const text = last === undefined ? hostTap(host) : stdoutText(last, artifacts);
      const parsed = parseTap(text);
      if (parsed.points.length === 0 && parsed.plan === undefined) {
        return [];
      }
      const failed = parsed.points.some((item) => !item.ok && item.directive === undefined);
      const relation: EvidenceRecord["relation"] = failed ? "REFUTES" : "SUPPORTS";
      return [
        evidenceFromParse({
          check,
          observations,
          relation,
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

function hostTap(host: ProducerHost): string {
  for (const path of host.listPaths()) {
    if (path.endsWith(".tap") || path.endsWith(".t")) {
      return host.readText(path) ?? "";
    }
  }
  return "";
}
