import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, parseJsonValue, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "playwright";

export type PlaywrightTrace = {
  titles: readonly string[];
  screenshots: number;
  ariaSnapshots: number;
};

export function parsePlaywrightTrace(text: string): PlaywrightTrace | undefined {
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    const parsed = parseJsonValue(text);
    if (parsed === undefined) {
      return undefined;
    }
    return fromJson(parsed);
  }
  const titles: string[] = [];
  const testRe = /test\((['"`])([^'"`]+)\1/g;
  let match = testRe.exec(text);
  while (match !== null) {
    if (match[2] !== undefined) {
      titles.push(match[2]);
    }
    match = testRe.exec(text);
  }
  if (titles.length === 0 && !text.includes("playwright")) {
    return undefined;
  }
  return {
    titles,
    screenshots: (text.match(/screenshot/gi) ?? []).length,
    ariaSnapshots: (text.match(/aria/gi) ?? []).length,
  };
}

function fromJson(value: unknown): PlaywrightTrace | undefined {
  const titles: string[] = [];
  walk(value, titles);
  if (titles.length === 0 && value !== null && typeof value === "object") {
    return { titles: [], screenshots: 0, ariaSnapshots: 0 };
  }
  return { titles, screenshots: 0, ariaSnapshots: 0 };
}

function walk(value: unknown, titles: string[]): void {
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, titles);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "title" || key === "name") && typeof entry === "string") {
      titles.push(entry);
    } else {
      walk(entry, titles);
    }
  }
}

export function createPlaywrightProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.includes("playwright") || path.includes("trace"))) {
        return [];
      }
      return [capability(ID, ["playwright-trace", "dom-aria", "screenshot"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (
        obligation.kind !== "BROWSER_INTERACTION" &&
        obligation.kind !== "VISUAL" &&
        obligation.kind !== "ACCESSIBILITY"
      ) {
        return [];
      }
      return [intrinsicCheck([obligation.id], "playwright-parse", versionObjectDigest, "CANDIDATE")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const parsed = parsePlaywrightTrace(stdoutText(last, artifacts));
      if (parsed === undefined) {
        return [];
      }
      const failed = last.exitCode !== undefined && last.exitCode !== 0;
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
