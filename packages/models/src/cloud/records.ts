import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { DeploymentCapabilitiesSchema, type DeploymentCapabilities } from "@pi-hec/contracts";

const CAPABILITIES = Compile(DeploymentCapabilitiesSchema);

const FIXTURE_FILES = [
  "cloud-openai-shaped-unknown.json",
  "cloud-second-provider-grade-c.json",
] as const;

function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "config", "models", "cloud-openai-shaped-unknown.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(fileURLToPath(import.meta.url), "../../../../..");
}

export function loadCloudCapabilityRecords(
  modelsDir = path.join(workspaceRoot(), "config", "models"),
): readonly DeploymentCapabilities[] {
  const records: DeploymentCapabilities[] = [];
  for (const fileName of FIXTURE_FILES) {
    const parsed: unknown = JSON.parse(readFileSync(path.join(modelsDir, fileName), "utf8"));
    if (!CAPABILITIES.Check(parsed)) {
      throw new Error(`invalid cloud capability record ${fileName}`);
    }
    records.push(parsed);
  }
  return records;
}

export function cloudCapabilityById(
  records: readonly DeploymentCapabilities[],
  deploymentId: string,
): DeploymentCapabilities | undefined {
  return records.find((item) => item.deploymentId === deploymentId);
}
