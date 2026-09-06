import { createPinnedLocalProvider } from "./provider.js";
import {
  CLOUD_PROVIDER_IDS,
  LocalAnalystFailure,
  type LocalDeploymentSeal,
  type StartupInventory,
} from "./types.js";
import type { IsolatedLocalRuntime } from "./runtime.js";

export type InventorySessionMeasurement = {
  agentsFileCount: number;
  extensionCount: number;
  skillCount: number;
  promptCount: number;
  themeCount: number;
  appendPromptCount: number;
  activeToolNames: readonly string[];
};

const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "powershell",
  "grep",
  "find",
  "ls",
]);

const NON_LOOPBACK_PROBE_URLS = ["http://example.com/v1", "http://10.0.0.1:80/v1"] as const;

function measureNonLoopbackDenied(seal: LocalDeploymentSeal): boolean {
  for (const baseUrl of NON_LOOPBACK_PROBE_URLS) {
    try {
      createPinnedLocalProvider({ ...seal, baseUrl });
      return false;
    } catch (error) {
      if (!(error instanceof LocalAnalystFailure) || error.code !== "NON_LOOPBACK_DENIED") {
        return false;
      }
    }
  }
  return true;
}

export async function collectStartupInventory(
  created: IsolatedLocalRuntime,
  session: InventorySessionMeasurement,
): Promise<StartupInventory> {
  const available = await created.modelRuntime.getAvailable();
  const cloudSelectable = available.some((model) => CLOUD_PROVIDER_IDS.has(model.provider));
  const stored = await created.credentials.list();
  const defaultResourceCount =
    session.agentsFileCount +
    session.skillCount +
    session.promptCount +
    session.themeCount +
    session.appendPromptCount;
  return {
    cloudDeploymentSelectable: cloudSelectable,
    cloudDeploymentCallable: cloudSelectable || stored.length > 0,
    providerCredentialCount: stored.length,
    defaultResourceAvailable: defaultResourceCount > 0,
    extensionToolAvailable: session.extensionCount > 0,
    builtinToolAvailable: session.activeToolNames.some((name) => BUILTIN_TOOL_NAMES.has(name)),
    nonLoopbackDenied: measureNonLoopbackDenied(created.seal),
    osIdentitySeparated: false,
  };
}
