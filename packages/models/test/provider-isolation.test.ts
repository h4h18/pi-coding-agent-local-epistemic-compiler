import { expect, test } from "vitest";
import { createPinnedLocalProvider, isLoopbackInferenceBaseUrl, wrapLoopbackProviderStreams } from "../src/index.js";
import { loopbackSeal } from "./helpers.js";

test("loopback baseUrl must be 127.0.0.1 and reject localhost, 0.0.0.0, and LAN", () => {
  expect(isLoopbackInferenceBaseUrl("http://127.0.0.1:8080/v1")).toBe(true);
  expect(isLoopbackInferenceBaseUrl("http://localhost:8080/v1")).toBe(false);
  expect(isLoopbackInferenceBaseUrl("http://0.0.0.0:8080/v1")).toBe(false);
  expect(isLoopbackInferenceBaseUrl("http://10.0.0.1:8080/v1")).toBe(false);
  expect(isLoopbackInferenceBaseUrl("http://example.com/v1")).toBe(false);
});

test("pinned local provider construction rejects non-loopback seals without opening a socket", () => {
  expect(() =>
    createPinnedLocalProvider({
      ...loopbackSeal(1),
      baseUrl: "http://example.com/v1",
    }),
  ).toThrow(/127\.0\.0\.1/);
  expect(() =>
    createPinnedLocalProvider({
      ...loopbackSeal(1),
      baseUrl: "http://10.0.0.1:80/v1",
    }),
  ).toThrow(/127\.0\.0\.1/);
  expect(() =>
    createPinnedLocalProvider({
      ...loopbackSeal(1),
      baseUrl: "http://localhost:8080/v1",
    }),
  ).toThrow(/127\.0\.0\.1/);
});

test("provider stream wrapper rejects tampered non-loopback model baseUrl before network", async () => {
  const inner = {
    stream: () => {
      throw new Error("inner stream must not run");
    },
    streamSimple: () => {
      throw new Error("inner streamSimple must not run");
    },
  };
  const wrapped = wrapLoopbackProviderStreams(inner);
  const tampered = {
    id: "hec-analyst",
    name: "tampered",
    api: "openai-completions" as const,
    provider: "hec-local",
    baseUrl: "http://example.com/v1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 256,
  };
  expect(() => wrapped.stream(tampered, { messages: [] }, {})).toThrow(/127\.0\.0\.1|loopback/);
  expect(() => wrapped.streamSimple(tampered, { messages: [] }, {})).toThrow(/127\.0\.0\.1|loopback/);
});
