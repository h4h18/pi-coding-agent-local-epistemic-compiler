import { expect, test } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { wrapLoopbackProviderStreams } from "../src/index.js";

test("Pi 0.84.3 ResourceLoader has no getPackages; empty packages are a Settings field", () => {
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  expect(settings.getPackages()).toEqual([]);
  expect(settings.getGlobalSettings().packages ?? []).toEqual([]);
});

test("Pi 0.84.3 openai-completions stream requires a client apiKey even for keyless loopback auth", () => {
  let seenApiKey: string | undefined;
  let seenAuthorization: string | undefined;
  const wrapped = wrapLoopbackProviderStreams({
    stream: (_model, _context, options) => {
      seenApiKey = options?.apiKey;
      const authorization = options?.headers?.Authorization ?? options?.headers?.authorization;
      seenAuthorization = authorization === null ? undefined : authorization;
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    },
    streamSimple: () => {
      throw new Error("streamSimple unused");
    },
  });
  wrapped.stream(
    {
      id: "hec-analyst",
      name: "HEC local analyst",
      api: "openai-completions",
      provider: "hec-local",
      baseUrl: "http://127.0.0.1:9/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    },
    { messages: [] },
    {},
  );
  expect(seenApiKey).toBe("hec-loopback");
  expect(seenAuthorization).toBe("Bearer hec-loopback");
});

test("Pi 0.84.3 Settings.retry.provider.maxRetries exists and noTools builtin remains the isolation switch", () => {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    defaultTools: [],
    enableSkillCommands: false,
    enableInstallTelemetry: false,
    enableAnalytics: false,
  });
  expect(settings.getRetrySettings().enabled).toBe(false);
  expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
  expect(settings.getDefaultTools()).toEqual([]);
  expect(settings.getEnableSkillCommands()).toBe(false);
  expect(settings.getEnableInstallTelemetry()).toBe(false);
  expect(settings.getEnableAnalytics()).toBe(false);
});

