import { expect, test } from "vitest";
import { startMockOpenAiServer } from "./mock-server.js";
import { postChatCompletion } from "./loopback-client.js";

const jsonSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

test("structured-output success returns JSON matching the requested schema", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
    advertiseCacheUsage: true,
  });
  try {
    const result = await postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "schema-ok: ping" }],
        extra_body: { structured_outputs: { json: jsonSchema } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.content)).toEqual({ answer: "pong" });
    expect(result.usage?.cached_tokens).toBe(3);
  } finally {
    await server.close();
  }
});

test("structured-output failure is scored as invalid JSON for the schema", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
  });
  try {
    const result = await postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "schema-fail: ping" }],
        extra_body: { structured_outputs: { json: jsonSchema } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed: unknown = JSON.parse(result.content);
    expect(parsed).toEqual({ not_answer: 1 });
  } finally {
    await server.close();
  }
});

test("AbortSignal cancellation does not retry", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
    stallMs: 5_000,
  });
  const controller = new AbortController();
  try {
    const pending = postChatCompletion({
      baseUrl: server.baseUrl,
      body: {
        model: "mock",
        messages: [{ role: "user", content: "slow" }],
      },
      signal: controller.signal,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(server.requestCount).toBe(1);
  } finally {
    await server.close();
  }
});

test("disconnect and malformed JSON do not retry", async () => {
  const disconnect = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
    disconnect: true,
  });
  try {
    const dropped = await postChatCompletion({
      baseUrl: disconnect.baseUrl,
      body: { model: "mock", messages: [{ role: "user", content: "hi" }] },
    });
    expect(dropped.ok).toBe(false);
    expect(disconnect.requestCount).toBe(1);
  } finally {
    await disconnect.close();
  }
  const malformed = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 2048,
    malformedJson: true,
  });
  try {
    const parsed = await postChatCompletion({
      baseUrl: malformed.baseUrl,
      body: { model: "mock", messages: [{ role: "user", content: "hi" }] },
    });
    expect(parsed.ok).toBe(false);
    expect(malformed.requestCount).toBe(1);
  } finally {
    await malformed.close();
  }
});

test("mock reports advertised vs measured context and binds 127.0.0.1", async () => {
  const server = await startMockOpenAiServer({
    advertisedContextTokens: 262144,
    measuredContextTokens: 4096,
  });
  try {
    expect(server.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(server.advertisedContextTokens).toBe(262144);
    expect(server.measuredContextTokens).toBe(4096);
    expect(server.measuredContextTokens).not.toBe(server.advertisedContextTokens);
  } finally {
    await server.close();
  }
});
