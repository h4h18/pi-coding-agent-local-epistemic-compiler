import { readFileSync } from "node:fs";
import path from "node:path";
import { Compile } from "typebox/compile";
import { DeploymentCapabilitiesSchema, type DeploymentCapabilities } from "@pi-hec/contracts";
import { modelsConfigDir, workspaceRoot } from "../local/deployment-config.js";

const CAPABILITIES = Compile(DeploymentCapabilitiesSchema);

const FIXTURE_FILES = [
  "cloud-openai-shaped-unknown.json",
  "cloud-second-provider-grade-c.json",
] as const;

export function loadCloudCapabilityRecords(
  modelsDir = modelsConfigDir(workspaceRoot()),
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
