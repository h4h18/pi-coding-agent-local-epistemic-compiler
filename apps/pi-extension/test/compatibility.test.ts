import { expect, test } from "vitest";
import {
  AgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getLatestCompactionEntry,
  type CreateModelRuntimeOptions,
  type ExtensionAPI,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import hecExtension, { createHecExtension } from "../src/index.js";
import { FakePi, RecordingBroker } from "./harness.js";

test("Pi 0.84.3 extension events, terminate, ResourceLoader, SessionManager, compaction, runtime, usage", async () => {
  expect(typeof hecExtension).toBe("function");
  expect(typeof createHecExtension).toBe("function");

  const terminate: ToolCallEventResult = { block: true, terminate: true, reason: "blocked" };
  expect(terminate.terminate).toBe(true);

  expect(Object.prototype.hasOwnProperty.call(DefaultResourceLoader.prototype, "getPackages")).toBe(
    false,
  );
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    warnings: { anthropicExtraUsage: true },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  expect(settings.getPackages()).toEqual([]);
  expect(settings.getGlobalSettings().packages ?? []).toEqual([]);
  expect(settings.getWarnings().anthropicExtraUsage).toBe(true);
  expect(settings.getRetrySettings().enabled).toBe(false);
  expect(settings.getProviderRetrySettings().maxRetries).toBe(0);

  const session = SessionManager.inMemory("C:\\tmp\\hec-compat");
  const customId = session.appendCustomEntry("hec-run-pointer", { activeRunId: "run_x" });
  expect(customId.length).toBeGreaterThan(0);
  const custom = session.getEntries().find((entry) => entry.type === "custom");
  expect(custom?.type).toBe("custom");
  if (custom?.type === "custom") {
    expect(custom.customType).toBe("hec-run-pointer");
  }

  const usage: Usage = {
    input: 12,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 16,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  session.appendCompaction("compacted", customId, 2048, { version: 1 }, false, usage);
  const compaction = getLatestCompactionEntry(session.getEntries());
  expect(compaction?.type).toBe("compaction");
  expect(compaction?.summary).toBe("compacted");
  expect(compaction?.firstKeptEntryId).toBe(customId);
  expect(compaction?.tokensBefore).toBe(2048);
  expect(compaction?.usage?.totalTokens).toBe(16);
  expect(compaction?.fromHook).toBe(false);

  const runtimeOptions: CreateModelRuntimeOptions = {
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelRefreshTimeoutMs: 1,
  };
  expect(runtimeOptions.allowModelNetwork).toBe(false);
  expect(runtimeOptions.refreshOnCreate).toBe(false);
  expect(typeof AgentSession.prototype.prompt).toBe("function");

  const factory: (pi: ExtensionAPI) => void = createHecExtension({
    broker: new RecordingBroker(),
    securityMode: "compatibility",
  });
  const pi = new FakePi();
  factory(pi as unknown as ExtensionAPI);
  expect(pi.commands.has("hec")).toBe(true);
  expect(pi.listeners.has("input")).toBe(true);
  expect(pi.listeners.has("session_start")).toBe(true);
  expect(pi.listeners.has("session_shutdown")).toBe(true);
  expect(pi.listeners.has("tool_call")).toBe(true);
  expect(pi.listeners.has("user_bash")).toBe(true);
  expect(pi.renderers.has("hec-run-pointer")).toBe(true);

  await pi.runCommand("mode on");
  const input = await pi.emitInput("from ExtensionAPI");
  expect(input).toEqual({ action: "handled" });
  const shutdown = await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  expect(shutdown).toBeUndefined();
  const tool = await pi.emit("tool_call", {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-compat",
    input: { command: "echo" },
  });
  expect(tool).toMatchObject({ block: true, terminate: true });
  const bash = await pi.emit("user_bash", {
    type: "user_bash",
    command: "echo hi",
    excludeFromContext: false,
    cwd: pi.cwd,
  });
  expect(bash).toMatchObject({ result: { exitCode: 1 } });
});
