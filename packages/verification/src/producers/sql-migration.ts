import type { CheckNode, EvidenceRecord, ProofObligation, RunObservation } from "@pi-hec/contracts";
import { capability, hostHasPath, intrinsicCheck } from "./helpers.js";
import { evidenceFromParse, lastObservation, stdoutText } from "./parse-support.js";
import type { ArtifactStore, EvidenceProducer, ProducerBindings, ProducerHost } from "./types.js";
import { producerVersionDigest } from "./version.js";

const ID = "sql-migration";

export type SqlMigrationScript = {
  name: string;
  direction: "up" | "down" | "unknown";
};

export function parseSqlMigrations(text: string): SqlMigrationScript[] {
  const scripts: SqlMigrationScript[] = [];
  const parts = text.split(/^--\s*>>>/m);
  for (const part of parts) {
    const nameMatch = /^\s*([A-Za-z0-9._-]+)/.exec(part);
    if (nameMatch === null || nameMatch[1] === undefined) {
      continue;
    }
    const lower = part.toLowerCase();
    let direction: SqlMigrationScript["direction"] = "unknown";
    if (lower.includes("rollback") || lower.includes("-- down") || lower.includes("migrate:down")) {
      direction = "down";
    } else if (lower.includes("migrate:up") || lower.includes("-- up") || lower.includes("begin;")) {
      direction = "up";
    }
    scripts.push({ name: nameMatch[1], direction });
  }
  if (scripts.length === 0 && /create\s+table|alter\s+table/i.test(text)) {
    scripts.push({ name: "inline", direction: "up" });
  }
  return scripts;
}

export function createSqlMigrationProducer(
  host: ProducerHost,
  artifacts: ArtifactStore,
  bindings: ProducerBindings,
): EvidenceProducer {
  const versionObjectDigest = producerVersionDigest(ID, "1");
  return {
    id: ID,
    versionObjectDigest,
    async probe() {
      if (!hostHasPath(host, (path) => path.includes("migration") || path.endsWith(".sql"))) {
        return [];
      }
      return [capability(ID, ["sql-migration-harness"])];
    },
    async plan(obligation: ProofObligation, capabilities) {
      if (capabilities.every((item) => item.producerId !== ID)) {
        return [];
      }
      if (obligation.kind !== "DATA_MIGRATION") {
        return [];
      }
      return [intrinsicCheck([obligation.id], "sql-migration-parse", versionObjectDigest, "PAIRED")];
    },
    async parse(check: CheckNode, observations: readonly RunObservation[]): Promise<readonly EvidenceRecord[]> {
      const last = lastObservation(observations);
      if (last === undefined) {
        return [];
      }
      const text = stdoutText(last, artifacts);
      const scripts = parseSqlMigrations(text);
      if (scripts.length === 0) {
        return [];
      }
      const failed = last.exitCode !== undefined && last.exitCode !== 0;
      return [
        evidenceFromParse({
          check,
          observations,
          relation: failed ? "REFUTES" : "SUPPORTS",
          origin: "VERIFIER",
          oracle: "EXPLICIT_EXPECTATION",
          producerId: ID,
          producerVersionObjectDigest: versionObjectDigest,
          bindings,
        }),
      ];
    },
  };
}
