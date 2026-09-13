import type {
  ExtensionAPI,
  InputEventResult,
  SessionShutdownEvent,
  ToolCallEventResult,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { HecRuntime, type HecExtensionOptions, type PiHost } from "./commands.js";

export const packageName = "@pi-hec/pi-extension";

export { HecRuntime, type HecContext, type HecExtensionOptions, type PiHost } from "./commands.js";
export {
  BrokerClient,
  createProcessClaim,
  filetimeEpochParts,
  filetimePartsToRfc3339,
  isTrustedView,
  readCurrentProcessIsAppContainer,
  sidFromBrokerEnv,
  unixMillisToRfc3339,
  TRUSTED_VIEWS,
} from "./broker-client.js";
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

export function createHecExtension(options: HecExtensionOptions = {}): (pi: PiHost) => void {
  return (pi: PiHost): void => {
    const runtime = new HecRuntime(pi, options);
    pi.registerCommand("hec", {
      description: "Hybrid Epistemic Compiler",
      handler: async (args, ctx) => {
        await runtime.handleCommand(args, ctx);
      },
    });
    pi.on("session_start", async (event, ctx) => {
      await runtime.onSessionStart(event, ctx);
    });
    pi.on("session_shutdown", async (event: SessionShutdownEvent) => {
      await runtime.onSessionShutdown(event);
    });
    pi.on("input", async (event, ctx): Promise<InputEventResult | undefined> => {
      return runtime.onInput(event, ctx);
    });
    pi.on("tool_call", (): ToolCallEventResult | undefined => {
      return runtime.onToolCall();
    });
    pi.on("user_bash", (): UserBashEventResult | undefined => {
      return runtime.onUserBash();
    });
  };
}

export default function hecExtension(pi: ExtensionAPI): void {
  createHecExtension(optionsFromEnv())(pi);
}
