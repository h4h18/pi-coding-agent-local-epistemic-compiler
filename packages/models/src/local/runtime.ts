import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEmptyAclRestrictedAgentDir } from "./agent-dir.js";
import { loadModelConfigDirectory } from "./deployment-config.js";
import { deriveLocalDeploymentSeal } from "./deployment-seal.js";
import { scrubProviderCredentialEnv } from "./env.js";
import { createPinnedLocalProvider, isLoopbackInferenceBaseUrl } from "./provider.js";
import { CLOUD_PROVIDER_IDS, LocalAnalystFailure, type LocalDeploymentSeal } from "./types.js";

export type IsolatedLocalRuntime = {
  modelRuntime: ModelRuntime;
  credentials: InMemoryCredentialStore;
  model: Model<Api>;
  seal: LocalDeploymentSeal;
};

export function workspaceRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "config", "models", "selected.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(fileURLToPath(import.meta.url), "../../../../..");
}

export async function openProductionLocalSeal(
  root: string = workspaceRoot(),
): Promise<LocalDeploymentSeal | undefined> {
  const modelsDir = path.join(root, "config", "models");
  if (!existsSync(path.join(modelsDir, "selected.json"))) {
    return undefined;
  }
  const config = await loadModelConfigDirectory(modelsDir);
  return deriveLocalDeploymentSeal(config);
}

export async function requireExactPinnedLocalModel(
  modelRuntime: ModelRuntime,
  seal: LocalDeploymentSeal,
): Promise<Model<Api>> {
  if (CLOUD_PROVIDER_IDS.has(seal.providerId)) {
    throw new LocalAnalystFailure(
      "CLOUD_PROVIDER_DENIED",
      `provider ${seal.providerId} is a cloud provider and cannot be selected`,
    );
  }
  if (!isLoopbackInferenceBaseUrl(seal.baseUrl)) {
    throw new LocalAnalystFailure(
      "NON_LOOPBACK_DENIED",
      `seal baseUrl ${seal.baseUrl} is not the pinned loopback inference socket`,
    );
  }
  const available = await modelRuntime.getAvailable();
  const match = available.find(
    (model) =>
      model.provider === seal.providerId &&
      model.id === seal.modelId &&
      model.baseUrl === seal.baseUrl &&
      model.headers?.["x-hec-model-revision"] === seal.modelRevision,
  );
  if (match === undefined) {
    throw new LocalAnalystFailure(
      "LOCAL_MODEL_NOT_PINNED",
      `no available model matches provider=${seal.providerId} id=${seal.modelId} revision=${seal.modelRevision}`,
    );
  }
  const extras = available.filter((model) => model !== match);
  if (extras.length > 0) {
    throw new LocalAnalystFailure(
      "LOCAL_MODEL_NOT_PINNED",
      `unexpected extra available models: ${extras.map((model) => `${model.provider}/${model.id}`).join(",")}`,
    );
  }
  return match;
}

export async function createIsolatedLocalRuntime(
  seal: LocalDeploymentSeal,
): Promise<IsolatedLocalRuntime> {
  scrubProviderCredentialEnv();
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const provider = createPinnedLocalProvider(seal);
  modelRuntime.registerNativeProvider(provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = await requireExactPinnedLocalModel(modelRuntime, seal);
  return { modelRuntime, credentials, model, seal };
}

export async function createIsolatedLocalRuntimeFromProduction(
  root?: string,
): Promise<IsolatedLocalRuntime> {
  const seal = await openProductionLocalSeal(root);
  if (seal === undefined) {
    throw new LocalAnalystFailure(
      "LOCAL_DEPLOYMENT_SEAL_MISSING",
      "config/models/selected.json has no signed local deployment; local analyst fail-closed",
    );
  }
  return createIsolatedLocalRuntime(seal);
}

export { createEmptyAclRestrictedAgentDir };
