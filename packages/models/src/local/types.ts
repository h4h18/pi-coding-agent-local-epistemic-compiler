export type LocalDeploymentSeal = {
  providerId: string;
  modelId: string;
  modelRevision: string;
  baseUrl: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
};

export type LocalAnalystFailureCode =
  | "LOCAL_DEPLOYMENT_SEAL_MISSING"
  | "LOCAL_MODEL_NOT_PINNED"
  | "NON_LOOPBACK_DENIED"
  | "CLOUD_PROVIDER_DENIED";

export class LocalAnalystFailure extends Error {
  readonly code: LocalAnalystFailureCode;

  constructor(code: LocalAnalystFailureCode, message: string) {
    super(message);
    this.name = "LocalAnalystFailure";
    this.code = code;
  }
}

export type StartupInventory = {
  cloudDeploymentSelectable: boolean;
  cloudDeploymentCallable: boolean;
  providerCredentialCount: number;
  defaultResourceAvailable: boolean;
  extensionToolAvailable: boolean;
  builtinToolAvailable: boolean;
  nonLoopbackDenied: boolean;
  osIdentitySeparated: boolean;
};

export const CLOUD_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure-openai-responses",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "mistral",
  "nvidia",
  "openai",
  "openai-codex",
  "openrouter",
  "together",
  "xai",
]);
