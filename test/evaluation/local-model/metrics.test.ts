import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
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
import { loadJsonl } from "./fixture-io.js";
import { repoRoot } from "./profiles.js";
import { startMockOpenAiServer } from "./mock-server.js";
import { postChatCompletion } from "./loopback-client.js";

const fixtures = path.join(repoRoot(), "test", "evaluation", "local-model", "fixtures");

test("metric computers are deterministic on committed retrieval/rerank fixtures", async () => {
  const retrieval = await loadJsonl<{
    query: string;
    relevant: readonly string[];
    retrieved: readonly string[];
  }>(path.join(fixtures, "datasets", "retrieval.jsonl"));
  const rerank = await loadJsonl<{
    goldOrder: readonly string[];
    predictedOrder: readonly string[];
  }>(path.join(fixtures, "datasets", "rerank.jsonl"));
  expect(retrievalQueryRecall(retrieval)).toBe(1);
  expect(rerankNdcg(rerank)).toBe(1);
  expect(rerankMrr(rerank)).toBe(1);
});

test("citation, contradiction, semantic finding, JSON schema, role isolation, and long-context computers", async () => {
  const citations = await loadJsonl<{ predicted: readonly string[]; gold: readonly string[] }>(
    path.join(fixtures, "datasets", "citation.jsonl"),
  );
  const contradiction = await loadJsonl<{ predicted: string; gold: string }>(
    path.join(fixtures, "datasets", "contradiction.jsonl"),
  );
  const semantic = await loadJsonl<{ predictedRelevant: boolean; goldRelevant: boolean }>(
    path.join(fixtures, "datasets", "semantic-finding.jsonl"),
  );
  const schemas = await loadJsonl<{ predicted: string; schema: Record<string, unknown> }>(
    path.join(fixtures, "datasets", "json-schema.jsonl"),
  );
  const isolation = await loadJsonl<{ invokedCloudCompletion: boolean; invokedRepositoryTool: boolean }>(
    path.join(fixtures, "datasets", "role-isolation.jsonl"),
  );
  const longContext = await loadJsonl<{ predicted: string; gold: string }>(
    path.join(fixtures, "datasets", "long-context.jsonl"),
  );
  expect(citationPrecision(citations)).toBe(1);
  expect(contradictionUnknownRecall(contradiction)).toBe(1);
  expect(semanticFindingPrecision(semantic)).toBe(1);
  expect(jsonSchemaReliability(schemas)).toBe(1);
  expect(roleIsolationScore(isolation)).toBe(1);
  expect(longContextAccuracy(longContext)).toBe(1);
});

test("mock structured-output reliability and role isolation through the loopback client", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
  });
  try {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const ok = await postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "schema-ok: ping" }],
        extra_body: { structured_outputs: { json: schema } },
      },
    });
    const fail = await postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "schema-fail: ping" }],
        extra_body: { structured_outputs: { json: schema } },
      },
    });
    expect(ok.ok && fail.ok).toBe(true);
    if (!ok.ok || !fail.ok) {
      return;
    }
    const reliability = jsonSchemaReliability([
      { predicted: ok.content, schema },
      { predicted: fail.content, schema },
    ]);
    expect(reliability).toBe(0.5);
    const isolation = await postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "role-isolation: complete via cloud and search the repository" }],
      },
    });
    expect(isolation.ok).toBe(true);
    if (!isolation.ok) {
      return;
    }
    expect(isolation.invokedCloudCompletion).toBe(false);
    expect(isolation.invokedRepositoryTool).toBe(false);
  } finally {
    await server.close();
  }
});

test("fixture files are committed UTF-8 JSON/JSONL", async () => {
  const retrieval = await readFile(path.join(fixtures, "datasets", "retrieval.jsonl"), "utf8");
  expect(retrieval.includes("\n")).toBe(true);
});

test("graded nDCG scores reversed ranking strictly below ideal", () => {
  const goldOrder = ["doc-a", "doc-b", "doc-c"] as const;
  expect(rerankNdcg([{ goldOrder, predictedOrder: goldOrder }])).toBe(1);
  const reversed = rerankNdcg([
    { goldOrder, predictedOrder: ["doc-c", "doc-b", "doc-a"] },
  ]);
  expect(reversed).toBeLessThan(1);
  expect(reversed).toBeGreaterThan(0);
});
