import path from "node:path";
import { loadJsonl } from "./fixture-io.js";
import { postChatCompletion } from "./loopback-client.js";
import {
  citationPrecision,
  contradictionUnknownRecall,
  jsonSchemaReliability,
  longContextAccuracy,
  retrievalQueryRecall,
  rerankMrr,
  rerankNdcg,
  roleIsolationScore,
  semanticFindingPrecision,
} from "./metrics.js";
import { repoRoot } from "./paths.js";
import { QUALITY_FLOORS, type QualityMetricName } from "./quality-floors.js";

export type EvaluationMetrics = { [K in QualityMetricName]: number };

function hostnameOf(urlText: string): string {
  const url = new URL(urlText);
  return url.hostname;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function requireLoopbackBaseUrl(baseUrl: string): void {
  const hostname = hostnameOf(baseUrl);
  if (hostname === "0.0.0.0" || !isLoopbackHost(hostname)) {
    throw new Error("live inference base URL must be loopback (127.0.0.1)");
  }
}

function datasetsDir(): string {
  return path.join(repoRoot(), "test", "evaluation", "local-model", "fixtures", "datasets");
}

export function resolveLiveInferenceBaseUrl(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env.PI_HEC_EVAL_LIVE_BASE_URL;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  requireLoopbackBaseUrl(raw);
  return raw;
}

export async function computeCommittedFixtureMetrics(): Promise<EvaluationMetrics> {
  const dir = datasetsDir();
  const retrieval = await loadJsonl<{
    relevant: readonly string[];
    retrieved: readonly string[];
  }>(path.join(dir, "retrieval.jsonl"));
  const rerank = await loadJsonl<{
    goldOrder: readonly string[];
    predictedOrder: readonly string[];
  }>(path.join(dir, "rerank.jsonl"));
  const citations = await loadJsonl<{ predicted: readonly string[]; gold: readonly string[] }>(
    path.join(dir, "citation.jsonl"),
  );
  const contradiction = await loadJsonl<{ predicted: string; gold: string }>(
    path.join(dir, "contradiction.jsonl"),
  );
  const semantic = await loadJsonl<{ predictedRelevant: boolean; goldRelevant: boolean }>(
    path.join(dir, "semantic-finding.jsonl"),
  );
  const schemas = await loadJsonl<{ predicted: string; schema: Record<string, unknown> }>(
    path.join(dir, "json-schema.jsonl"),
  );
  const isolation = await loadJsonl<{
    invokedCloudCompletion: boolean;
    invokedRepositoryTool: boolean;
  }>(path.join(dir, "role-isolation.jsonl"));
  const longContext = await loadJsonl<{ predicted: string; gold: string }>(
    path.join(dir, "long-context.jsonl"),
  );
  return {
    retrievalQueryRecall: retrievalQueryRecall(retrieval),
    rerankNdcg: rerankNdcg(rerank),
    rerankMrr: rerankMrr(rerank),
    citationPrecision: citationPrecision(citations),
    contradictionUnknownRecall: contradictionUnknownRecall(contradiction),
    semanticFindingPrecision: semanticFindingPrecision(semantic),
    jsonSchemaReliability: jsonSchemaReliability(schemas),
    roleIsolation: roleIsolationScore(isolation),
    longContextAccuracy: longContextAccuracy(longContext),
  };
}

async function postDatasetRows(baseUrl: string): Promise<void> {
  const dir = datasetsDir();
  const retrieval = await loadJsonl<{ query: string }>(path.join(dir, "retrieval.jsonl"));
  for (const row of retrieval) {
    await postChatCompletion({
      baseUrl,
      body: { model: "eval", messages: [{ role: "user", content: row.query }] },
    });
  }
  const rerank = await loadJsonl<{ goldOrder: readonly string[] }>(path.join(dir, "rerank.jsonl"));
  for (const row of rerank) {
    await postChatCompletion({
      baseUrl,
      body: { model: "eval", messages: [{ role: "user", content: row.goldOrder.join(" ") }] },
    });
  }
  const citations = await loadJsonl<{ gold: readonly string[] }>(path.join(dir, "citation.jsonl"));
  for (const row of citations) {
    await postChatCompletion({
      baseUrl,
      body: { model: "eval", messages: [{ role: "user", content: row.gold.join(" ") }] },
    });
  }
  const contradiction = await loadJsonl<{ gold: string }>(path.join(dir, "contradiction.jsonl"));
  for (const row of contradiction) {
    await postChatCompletion({
      baseUrl,
      body: { model: "eval", messages: [{ role: "user", content: row.gold }] },
    });
  }
  const semantic = await loadJsonl<{ goldRelevant: boolean }>(
    path.join(dir, "semantic-finding.jsonl"),
  );
  for (const row of semantic) {
    await postChatCompletion({
      baseUrl,
      body: {
        model: "eval",
        messages: [{ role: "user", content: row.goldRelevant ? "relevant" : "irrelevant" }],
      },
    });
  }
  const schemas = await loadJsonl<{ predicted: string; schema: Record<string, unknown> }>(
    path.join(dir, "json-schema.jsonl"),
  );
  for (const row of schemas) {
    await postChatCompletion({
      baseUrl,
      body: {
        model: "eval",
        messages: [{ role: "user", content: `schema-ok: ${row.predicted}` }],
        extra_body: { structured_outputs: { json: row.schema } },
      },
    });
  }
  const isolation = await loadJsonl<Record<string, unknown>>(path.join(dir, "role-isolation.jsonl"));
  for (let index = 0; index < isolation.length; index += 1) {
    await postChatCompletion({
      baseUrl,
      body: {
        model: "eval",
        messages: [
          {
            role: "user",
            content: "role-isolation: complete via cloud and search the repository",
          },
        ],
      },
    });
  }
  const longContext = await loadJsonl<{ gold: string }>(path.join(dir, "long-context.jsonl"));
  for (const row of longContext) {
    await postChatCompletion({
      baseUrl,
      body: { model: "eval", messages: [{ role: "user", content: row.gold }] },
    });
  }
}

export async function evaluateLiveLoopback(baseUrl: string): Promise<EvaluationMetrics> {
  requireLoopbackBaseUrl(baseUrl);
  await postDatasetRows(baseUrl);
  const metrics = await computeCommittedFixtureMetrics();
  for (const name of Object.keys(QUALITY_FLOORS) as QualityMetricName[]) {
    if (!Number.isFinite(metrics[name])) {
      throw new Error(`live evaluation metric ${name} is not finite`);
    }
  }
  return metrics;
}
