import type { Context, Model, ProviderStreams, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";

type LoopbackModel = Model<"openai-completions">;
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { CLOUD_PROVIDER_IDS, LocalAnalystFailure, type LocalDeploymentSeal } from "./types.js";

export function isLoopbackInferenceBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/v1";
  } catch {
    return false;
  }
}

export function assertLoopbackInferenceBaseUrl(baseUrl: string): void {
  if (!isLoopbackInferenceBaseUrl(baseUrl)) {
    throw new LocalAnalystFailure(
      "NON_LOOPBACK_DENIED",
      `local inference baseUrl must be http://127.0.0.1:<port>/v1, got ${baseUrl}`,
    );
  }
}

function assertLoopbackModel(model: LoopbackModel): void {
  if (CLOUD_PROVIDER_IDS.has(model.provider)) {
    throw new LocalAnalystFailure(
      "CLOUD_PROVIDER_DENIED",
      `cloud provider ${model.provider} is not selectable for local analyst`,
    );
  }
  assertLoopbackInferenceBaseUrl(model.baseUrl);
}

function hasAuthorizationHeader(headers: Record<string, string | null> | undefined): boolean {
  if (headers === undefined) {
    return false;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && value !== null && value.trim().length > 0) {
      return true;
    }
    if (key.toLowerCase() === "cf-aig-authorization" && value !== null && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

const LOOPBACK_CLIENT_KEY = "hec-loopback";

function withLoopbackClientAuth(options?: StreamOptions): StreamOptions {
  const headers: Record<string, string | null> = { ...(options?.headers ?? {}) };
  if (!hasAuthorizationHeader(headers)) {
    headers.Authorization = `Bearer ${LOOPBACK_CLIENT_KEY}`;
  }
  return {
    ...options,
    apiKey: options?.apiKey !== undefined && options.apiKey.length > 0 ? options.apiKey : LOOPBACK_CLIENT_KEY,
    headers,
  };
}

export function wrapLoopbackProviderStreams(streams: ProviderStreams): ProviderStreams {
  const fetchDeferred = streams.fetchDeferred;
  const cancelDeferred = streams.cancelDeferred;
  return {
    stream(model: LoopbackModel, context: Context, options?: StreamOptions) {
      assertLoopbackModel(model);
      return streams.stream(model, context, withLoopbackClientAuth(options));
    },
    streamSimple(model: LoopbackModel, context: Context, options?: SimpleStreamOptions) {
      assertLoopbackModel(model);
      return streams.streamSimple(model, context, withLoopbackClientAuth(options));
    },
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (
            model: LoopbackModel,
            handle: Parameters<NonNullable<ProviderStreams["fetchDeferred"]>>[1],
            options: Parameters<NonNullable<ProviderStreams["fetchDeferred"]>>[2],
          ) => {
            assertLoopbackModel(model);
            return fetchDeferred(model, handle, withLoopbackClientAuth(options));
          },
        }),
    ...(cancelDeferred === undefined
      ? {}
      : {
          cancelDeferred: async (
            model: LoopbackModel,
            handle: Parameters<NonNullable<ProviderStreams["cancelDeferred"]>>[1],
            options: Parameters<NonNullable<ProviderStreams["cancelDeferred"]>>[2],
          ) => {
            assertLoopbackModel(model);
            await cancelDeferred(model, handle, withLoopbackClientAuth(options));
          },
        }),
  };
}

export function createPinnedLocalProvider(seal: LocalDeploymentSeal) {
  if (CLOUD_PROVIDER_IDS.has(seal.providerId)) {
    throw new LocalAnalystFailure(
      "CLOUD_PROVIDER_DENIED",
      `cloud provider ${seal.providerId} cannot be pinned as the local analyst`,
    );
  }
  assertLoopbackInferenceBaseUrl(seal.baseUrl);
  const model: Model<"openai-completions"> = {
    id: seal.modelId,
    name: seal.name,
    api: "openai-completions",
    provider: seal.providerId,
    baseUrl: seal.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: seal.contextWindow,
    maxTokens: seal.maxTokens,
    headers: { "x-hec-model-revision": seal.modelRevision },
  };
  return createProvider({
    id: seal.providerId,
    name: seal.name,
    baseUrl: seal.baseUrl,
    auth: {
      apiKey: {
        name: "HEC local loopback",
        check: async () => ({ type: "api_key" as const, source: "hec-local-loopback" }),
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    api: wrapLoopbackProviderStreams(openAICompletionsApi()),
  });
}
