import { asAgentId, randomPrefixedUuidV7, type SpawnRequest } from "@pi-hec/contracts";
import { mintCapabilityToken } from "../capability.js";
import { assembleWorkerContext } from "../context.js";
import { createMemoryHandleStore } from "../memory-store.js";
import { createRoleTools } from "../tools.js";
import type {
  AgentHandle,
  AgentResult,
  AgentRuntime,
  AssembledContext,
  BridgePorts,
  CommandPorts,
  CustomToolDefinition,
  LiveHandleStore,
  RuntimeCapabilities,
  ScopedFsPorts,
} from "../types.js";

export type RoleTurn = {
  messages: readonly { role: "system" | "user" | "assistant" | "tool"; content: string }[];
  tools: readonly CustomToolDefinition[];
};

export type RoleTurnResult = {
  text: string;
  toolCalls: readonly { id: string; name: string; argumentsText: string }[];
  finish: "tool_calls" | "stop" | "error";
};

export type RoleLoopPort = (turn: RoleTurn) => Promise<RoleTurnResult>;

export type DirectProviderLoopOptions = {
  complete: RoleLoopPort;
  bridge: BridgePorts;
  now: () => string;
  maxTurns?: number;
  assemble?: (request: SpawnRequest) => AssembledContext;
  store?: LiveHandleStore;
  fs?: ScopedFsPorts;
  commands?: CommandPorts;
};

const CAPABILITIES: RuntimeCapabilities = {
  adapter: "direct-provider-loop",
  version: "1.0.0",
  steer: true,
  resume: false,
  stop: true,
  nestedDelegation: false,
  fallbackSubagent: "none",
};

export function createDirectProviderLoopAdapter(options: DirectProviderLoopOptions): AgentRuntime {
  const store = options.store ?? createMemoryHandleStore();
  const queues = new Map<string, string[]>();
  const stopped = new Set<string>();
  const inflight = new Map<string, Promise<AgentResult>>();

  return {
    async capabilities() {
      return CAPABILITIES;
    },
    async spawn(request: SpawnRequest) {
      const now = options.now();
      const agentId = asAgentId(randomPrefixedUuidV7("agent_"));
      const token = mintCapabilityToken({
        runId: request.runId,
        nodeId: request.nodeId,
        agentId,
        role: request.role,
        toolProfile: request.toolProfile,
        now,
        expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
        ...(request.workspaceLeaseId === undefined ? {} : { leaseId: request.workspaceLeaseId }),
      });
      const context =
        options.assemble?.(request) ??
        assembleWorkerContext({
          role: request.role,
          outputSchema: request.outputSchema,
          priorArtifacts: request.inputArtifacts,
        });
      let accepted: unknown;
      let blocker: { questionId: string; question: string } | undefined;
      const tools = createRoleTools({
        token,
        now: options.now,
        bridge: {
          ...options.bridge,
          submitArtifact: async (input) => {
            const result = await options.bridge.submitArtifact(input);
            if (result.accepted) {
              accepted = input.envelope;
            }
            return result;
          },
          reportBlocker: async (input) => {
            blocker = { questionId: input.questionId, question: input.question };
            await options.bridge.reportBlocker(input);
          },
        },
        ...(options.fs === undefined ? {} : { fs: options.fs }),
        ...(options.commands === undefined ? {} : { commands: options.commands }),
      });
      const handle: AgentHandle = {
        agentId,
        runId: request.runId,
        nodeId: request.nodeId,
        role: request.role,
        sessionId: `direct-${agentId}`,
        toolProfile: request.toolProfile,
        capabilityTokenId: token.tokenId,
        adapter: "direct-provider-loop",
        adapterVersion: CAPABILITIES.version,
        spawnedAt: now,
        ...(request.workspaceLeaseId === undefined
          ? {}
          : { workspaceLeaseId: request.workspaceLeaseId }),
      };
      store.set(handle);
      queues.set(agentId, []);
      inflight.set(
        agentId,
        (async () => {
          const messages: { role: "system" | "user" | "assistant" | "tool"; content: string }[] = [
            { role: "system", content: context.systemPrompt },
            { role: "user", content: context.userPrompt },
          ];
          const maxTurns = options.maxTurns ?? 32;
          for (let turn = 0; turn < maxTurns; turn += 1) {
            if (stopped.has(agentId)) {
              return { outcome: "failed" as const, reason: "stopped" };
            }
            const steered = queues.get(agentId) ?? [];
            queues.set(agentId, []);
            for (const message of steered) {
              messages.push({ role: "user", content: message });
            }
            const result = await options.complete({ messages, tools });
            if (blocker !== undefined) {
              return { outcome: "blocker" as const, ...blocker };
            }
            if (accepted !== undefined) {
              return { outcome: "artifact" as const, envelope: accepted };
            }
            if (result.finish === "error") {
              return { outcome: "failed" as const, reason: result.text };
            }
            if (result.toolCalls.length === 0) {
              messages.push({ role: "assistant", content: result.text });
              continue;
            }
            for (const call of result.toolCalls) {
              const tool = tools.find((item) => item.name === call.name);
              if (tool === undefined) {
                if (call.name === "spawn_agent" || call.name === "delegate") {
                  throw new Error("nested delegation is forbidden");
                }
                messages.push({
                  role: "tool",
                  content: `unknown tool ${call.name}`,
                });
                continue;
              }
              let parsed: unknown = {};
              try {
                parsed = JSON.parse(call.argumentsText) as unknown;
              } catch {
                parsed = {};
              }
              const executed = await tool.execute(call.id, parsed);
              messages.push({ role: "tool", content: String(executed.content) });
            }
          }
          return { outcome: "failed" as const, reason: "max turns without artifact" };
        })(),
      );
      return handle;
    },
    async consume(handle) {
      const pending = inflight.get(handle.agentId);
      if (pending === undefined) {
        return { outcome: "lost", reason: "loop missing" };
      }
      return pending;
    },
    async steer(handle, message) {
      const queue = queues.get(handle.agentId);
      if (queue === undefined) {
        throw new Error("loop missing");
      }
      queue.push(message);
    },
    async stop(handle) {
      stopped.add(handle.agentId);
      store.delete(handle.agentId);
    },
    async reconcile(runId: AgentHandle["runId"]) {
      return {
        runId,
        handles: store.list(runId),
        nodeStatuses: Object.fromEntries(
          store.list(runId).map((handle) => [handle.nodeId, "SPAWNED" as const]),
        ),
      };
    },
  };
}
