import { rm } from "node:fs/promises";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  createEmptyAclRestrictedAgentDir,
  createIsolatedLocalRuntimeFromProduction,
  type IsolatedLocalRuntime,
} from "@pi-hec/models";
import type { TSchema } from "typebox";
import type { HeadlessSession, SessionFactory } from "./types.js";

export type PiSdkSessionFactoryOptions = {
  runtime?: IsolatedLocalRuntime;
};

export function createHeadlessResourceLoader(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => ({ path: "hec:worker-role-contract" }),
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: () => Promise.resolve(),
  };
}

async function resolveIsolatedRuntime(
  options: PiSdkSessionFactoryOptions | undefined,
): Promise<IsolatedLocalRuntime> {
  if (options?.runtime !== undefined) {
    return options.runtime;
  }
  return createIsolatedLocalRuntimeFromProduction();
}

export function createPiSdkSessionFactory(options?: PiSdkSessionFactoryOptions): SessionFactory {
  let isolated: Promise<IsolatedLocalRuntime> | undefined;
  const loadRuntime = (): Promise<IsolatedLocalRuntime> => {
    isolated ??= resolveIsolatedRuntime(options);
    return isolated;
  };
  return async (input) => {
    const local = await loadRuntime();
    const agentDir = await createEmptyAclRestrictedAgentDir();
    const resourceLoader = createHeadlessResourceLoader(input.systemPrompt);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        defaultTools: [],
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
        packages: [],
        enableSkillCommands: false,
        enableInstallTelemetry: false,
        enableAnalytics: false,
      }),
      resourceLoader,
      model: local.model,
      scopedModels: [{ model: local.model, thinkingLevel: "low" }],
      modelRuntime: local.modelRuntime,
      noTools: "builtin",
      customTools: input.tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters as TSchema,
        execute: async (toolCallId: string, params: unknown) => {
          const result = await tool.execute(toolCallId, params);
          return {
            content: [{ type: "text" as const, text: String(result.content) }],
            details: result.details,
          };
        },
      })),
    });
    return {
      sessionId: session.sessionId,
      prompt: async (text) => {
        await session.prompt(text, { expandPromptTemplates: false });
      },
      steer: async (text) => {
        await session.steer(text);
      },
      abort: async () => {
        await session.abort();
      },
      waitForIdle: async () => {
        await session.waitForIdle();
      },
      subscribe: (listener) =>
        session.subscribe((event) => {
          listener({ type: event.type });
        }),
      dispose: () => {
        session.dispose();
        void rm(agentDir, { recursive: true, force: true });
      },
    } satisfies HeadlessSession;
  };
}
