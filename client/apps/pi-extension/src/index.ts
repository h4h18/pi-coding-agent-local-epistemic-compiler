import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BrokerClient,
  connectLocalBrokerPipe,
  type BrokerPort,
} from "./broker-client.js";
import {
  processClaimOrInjected,
  readCurrentProcessIsAppContainer,
} from "./broker-windows.js";
import {
  createHecExtension as attachHec,
  type HecExtensionOptions,
  type PiHost,
} from "./commands.js";

export const packageName = "@pi-hec/pi-extension";

export {
  createHecExtension as attachHecRuntime,
  HecRuntime,
  type HecContext,
  type HecExtensionOptions,
  type PiHost,
} from "./commands.js";
export {
  BrokerClient,
  filetimeEpochParts,
  filetimePartsToRfc3339,
  isTrustedView,
  sidFromBrokerEnv,
  unixMillisToRfc3339,
  TRUSTED_VIEWS,
} from "./broker-client.js";
export {
  createProcessClaim,
  readCurrentProcessIsAppContainer,
} from "./broker-windows.js";
export type { BrokerPort, BrokerTransport, TrustedView } from "./broker-client.js";

function optionsFromEnv(): HecExtensionOptions {
  const alias = process.env.PI_HEC_WORKSPACE_ALIAS;
  const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT;
  return {
    securityMode:
      process.env.PI_HEC_SECURITY_MODE === "compatibility" ? "compatibility" : "production",
    ...(alias !== undefined && alias.length > 0 ? { workspaceAlias: alias } : {}),
    ...(endpoint !== undefined && endpoint.length > 0 ? { controlEndpointIdentity: endpoint } : {}),
  };
}

function productionBroker(options: HecExtensionOptions): () => Promise<BrokerPort> {
  return async () => {
    const claim = processClaimOrInjected(options.processClaim, options.processTimes);
    if (options.transport !== undefined) {
      return BrokerClient.connect(options.transport, claim);
    }
    return connectLocalBrokerPipe(claim);
  };
}

export function createHecExtension(options: HecExtensionOptions = {}): (pi: PiHost) => void {
  return attachHec({
    ...options,
    confinement:
      options.confinement ?? (() => ({ confined: readCurrentProcessIsAppContainer() })),
    openBroker: options.openBroker ?? productionBroker(options),
  });
}

export default function hecExtension(pi: ExtensionAPI): void {
  createHecExtension(optionsFromEnv())(pi);
}
