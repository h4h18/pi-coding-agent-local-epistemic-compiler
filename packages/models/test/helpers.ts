import type { LocalDeploymentSeal } from "../src/index.js";

export const LOOPBACK_PROVIDER = "hec-local";
export const LOOPBACK_MODEL = "hec-analyst";
export const LOOPBACK_REVISION = "test-loopback-1";

export function loopbackSeal(port: number): LocalDeploymentSeal {
  return {
    providerId: LOOPBACK_PROVIDER,
    modelId: LOOPBACK_MODEL,
    modelRevision: LOOPBACK_REVISION,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    name: "HEC local analyst",
    contextWindow: 8192,
    maxTokens: 2048,
  };
}
