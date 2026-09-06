import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  collectStartupInventory,
  createEmptyAclRestrictedAgentDir,
  createIsolatedLocalRuntime,
  createIsolatedLocalRuntimeFromProduction,
  openProductionLocalSeal,
  requireExactPinnedLocalModel,
  scrubProviderCredentialEnv,
  type InventorySessionMeasurement,
} from "../src/index.js";
import { loopbackSeal } from "./helpers.js";

const restored = new Map<string, string | undefined>();

function stashEnv(keys: readonly string[]): void {
  for (const key of keys) {
    restored.set(key, process.env[key]);
  }
}

afterEach(() => {
  for (const [key, value] of restored) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  restored.clear();
});

test("ModelRuntime.create uses in-memory credentials, modelsPath null, and no network refresh", async () => {
  const created = await createIsolatedLocalRuntime(loopbackSeal(9));
  expect(created.credentials).toBeInstanceOf(InMemoryCredentialStore);
  const available = await created.modelRuntime.getAvailable();
  expect(available).toHaveLength(1);
  const only = available[0];
  expect(only?.provider).toBe("hec-local");
  expect(only?.id).toBe("hec-analyst");
  expect(only?.baseUrl).toBe("http://127.0.0.1:9/v1");
});

test("getAvailable after register contains only the sealed local model", async () => {
  const created = await createIsolatedLocalRuntime(loopbackSeal(43111));
  const available = await created.modelRuntime.getAvailable();
  expect(available.map((model) => `${model.provider}/${model.id}`)).toEqual([
    "hec-local/hec-analyst",
  ]);
  expect(available.some((model) => model.provider === "anthropic")).toBe(false);
  expect(available.some((model) => model.provider === "openai")).toBe(false);
  expect(available.some((model) => model.provider === "google")).toBe(false);
});

test("cloud provider ids are not selectable even when env keys existed before scrub", async () => {
  stashEnv(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]);
  process.env.OPENAI_API_KEY = "sk-openai-must-not-select";
  process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-select";
  process.env.GOOGLE_API_KEY = "google-must-not-select";
  const created = await createIsolatedLocalRuntime(loopbackSeal(43112));
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  const available = await created.modelRuntime.getAvailable();
  expect(available.every((model) => model.provider === "hec-local")).toBe(true);
  expect(await created.credentials.read("openai")).toBeUndefined();
  expect(await created.credentials.read("anthropic")).toBeUndefined();
});

test("requireExactPinnedLocalModel rejects provider, baseUrl, or revision not in the seal", async () => {
  const created = await createIsolatedLocalRuntime(loopbackSeal(43113));
  await expect(
    requireExactPinnedLocalModel(created.modelRuntime, {
      ...loopbackSeal(43113),
      providerId: "anthropic",
    }),
  ).rejects.toMatchObject({ code: "CLOUD_PROVIDER_DENIED" });
  await expect(
    requireExactPinnedLocalModel(created.modelRuntime, {
      ...loopbackSeal(43113),
      baseUrl: "http://example.com/v1",
    }),
  ).rejects.toMatchObject({ code: "NON_LOOPBACK_DENIED" });
  await expect(
    requireExactPinnedLocalModel(created.modelRuntime, {
      ...loopbackSeal(43113),
      modelRevision: "other-revision",
    }),
  ).rejects.toMatchObject({ code: "LOCAL_MODEL_NOT_PINNED" });
});

test("production selected set is empty so the local runtime fail-closes without a seal", async () => {
  await expect(openProductionLocalSeal()).resolves.toBeUndefined();
  await expect(createIsolatedLocalRuntimeFromProduction()).rejects.toMatchObject({
    code: "LOCAL_DEPLOYMENT_SEAL_MISSING",
  });
});

test("env scrubber strips provider credentials and sets worker Pi flags", () => {
  stashEnv([
    "OPENAI_API_KEY",
    "AZURE_OPENAI_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "PI_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "HF_API_KEY",
    "PI_SKIP_VERSION_CHECK",
    "PI_TELEMETRY",
  ]);
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.AZURE_OPENAI_KEY = "azure-test";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-test";
  process.env.PI_API_KEY = "pi-cred";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.CEREBRAS_API_KEY = "cerebras-test";
  process.env.HF_API_KEY = "hf-test";
  const result = scrubProviderCredentialEnv();
  expect(result.removed.OPENAI_API_KEY).toBe("sk-test");
  expect(result.removed.OPENROUTER_API_KEY).toBe("sk-or-test");
  expect(result.removed.HF_API_KEY).toBe("hf-test");
  expect(process.env.OPENAI_API_KEY).toBeUndefined();
  expect(process.env.AZURE_OPENAI_KEY).toBeUndefined();
  expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(process.env.PI_API_KEY).toBeUndefined();
  expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  expect(process.env.CEREBRAS_API_KEY).toBeUndefined();
  expect(process.env.HF_API_KEY).toBeUndefined();
  expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
  expect(process.env.PI_TELEMETRY).toBe("0");
});

const EMPTY_SESSION: InventorySessionMeasurement = {
  agentsFileCount: 0,
  extensionCount: 0,
  skillCount: 0,
  promptCount: 0,
  themeCount: 0,
  appendPromptCount: 0,
  activeToolNames: [],
};

test("startup inventory records no cloud selectable models, empty credentials, and denied non-loopback", async () => {
  const created = await createIsolatedLocalRuntime(loopbackSeal(43114));
  const inventory = await collectStartupInventory(created, EMPTY_SESSION);
  expect(inventory.cloudDeploymentSelectable).toBe(false);
  expect(inventory.cloudDeploymentCallable).toBe(false);
  expect(inventory.providerCredentialCount).toBe(0);
  expect(inventory.defaultResourceAvailable).toBe(false);
  expect(inventory.extensionToolAvailable).toBe(false);
  expect(inventory.builtinToolAvailable).toBe(false);
  expect(inventory.nonLoopbackDenied).toBe(true);
  expect(inventory.osIdentitySeparated).toBe(false);
});

test("startup inventory measures resources and builtins from session facts, not constants", async () => {
  const created = await createIsolatedLocalRuntime(loopbackSeal(43115));
  const withBuiltin = await collectStartupInventory(created, {
    ...EMPTY_SESSION,
    activeToolNames: ["bash"],
  });
  expect(withBuiltin.builtinToolAvailable).toBe(true);
  const withResources = await collectStartupInventory(created, {
    ...EMPTY_SESSION,
    agentsFileCount: 1,
    extensionCount: 2,
  });
  expect(withResources.defaultResourceAvailable).toBe(true);
  expect(withResources.extensionToolAvailable).toBe(true);
  const isolated = await collectStartupInventory(created, EMPTY_SESSION);
  expect(isolated.builtinToolAvailable).toBe(false);
  expect(isolated.defaultResourceAvailable).toBe(false);
  expect(isolated.extensionToolAvailable).toBe(false);
});

test("OPENROUTER_API_KEY is scrubbed and openrouter is not selectable", async () => {
  stashEnv(["OPENROUTER_API_KEY"]);
  process.env.OPENROUTER_API_KEY = "sk-or-must-not-select";
  const created = await createIsolatedLocalRuntime(loopbackSeal(43116));
  expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
  const available = await created.modelRuntime.getAvailable();
  expect(available.some((model) => model.provider === "openrouter")).toBe(false);
  expect(await created.credentials.read("openrouter")).toBeUndefined();
});

test("agentDir helper is empty and is not the real ~/.pi/agent", async () => {
  const dir = await createEmptyAclRestrictedAgentDir();
  const homeAgent = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent");
  expect(path.resolve(dir)).not.toBe(path.resolve(homeAgent));
  expect(await readdir(dir)).toEqual([]);
});
