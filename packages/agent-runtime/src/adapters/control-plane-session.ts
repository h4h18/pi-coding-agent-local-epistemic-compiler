import { asAgentId, randomPrefixedUuidV7, type SpawnRequest } from "@pi-hec/contracts";
import { mintCapabilityToken } from "../capability.js";
import { assembleWorkerContext, withAgentBinding } from "../context.js";
import { createMemoryHandleStore } from "../memory-store.js";
import { createRoleTools } from "../tools.js";
import type {
  AgentHandle,
  AgentResult,
  AgentRuntime,
  AssembledContext,
  BridgePorts,
  CommandPorts,
  HeadlessSession,
  LiveHandleStore,
  RuntimeCapabilities,
  ScopedFsPorts,
  SessionFactory,
} from "../types.js";

export type ControlPlaneSessionAdapterOptions = {
  sessionFactory: SessionFactory;
  bridge: BridgePorts;
  now: () => string;
  tokenTtlMs?: number;
  fs?: ScopedFsPorts;
  commands?: CommandPorts;
  assemble?: (request: SpawnRequest) => AssembledContext | Promise<AssembledContext>;
  store?: LiveHandleStore;
  leaseFor?: (request: SpawnRequest) =>
    | {
        schemaVersion: 1;
        leaseId: NonNullable<SpawnRequest["workspaceLeaseId"]>;
        runId: SpawnRequest["runId"];
        nodeId: string;
        overlayPath: string;
        branch: string;
        baseCommit: string;
        allowedPaths: string[];
        isolationVerified: boolean;
        createdAt: string;
        expiresAt: string;
      }
    | undefined;
};

const CAPABILITIES: RuntimeCapabilities = {
  adapter: "control-plane-session",
  version: "1.0.0",
  steer: true,
  resume: true,
  stop: true,
  nestedDelegation: false,
  fallbackSubagent: "none",
};

export function createControlPlaneSessionAdapter(
  options: ControlPlaneSessionAdapterOptions,
): AgentRuntime {
  const store = options.store ?? createMemoryHandleStore();
  const sessions = new Map<string, HeadlessSession>();
  const results = new Map<string, AgentResult>();

  return {
    async capabilities() {
      return CAPABILITIES;
    },
    async spawn(request: SpawnRequest) {
      const now = options.now();
      const expires = new Date(Date.parse(now) + (options.tokenTtlMs ?? 3_600_000)).toISOString();
      const agentId = asAgentId(randomPrefixedUuidV7("agent_"));
      const token = mintCapabilityToken({
        runId: request.runId,
        nodeId: request.nodeId,
        agentId,
        role: request.role,
        toolProfile: request.toolProfile,
        now,
        expiresAt: expires,
        ...(request.workspaceLeaseId === undefined ? {} : { leaseId: request.workspaceLeaseId }),
      });
      const assembled = await Promise.resolve(
        options.assemble?.(request) ??
          assembleWorkerContext({
            role: request.role,
            outputSchema: request.outputSchema,
            priorArtifacts: request.inputArtifacts,
          }),
      );
      const context = withAgentBinding(assembled, {
        runId: request.runId,
        nodeId: request.nodeId,
        agentId,
      });
      const lease = options.leaseFor?.(request);
      const tools = createRoleTools({
        token,
        now: options.now,
        bridge: {
          ...options.bridge,
          submitArtifact: async (input) => {
            const submitted = await options.bridge.submitArtifact(input);
            if (submitted.accepted) {
              results.set(agentId, { outcome: "artifact", envelope: input.envelope });
            }
            return submitted;
          },
          reportBlocker: async (input) => {
            results.set(agentId, {
              outcome: "blocker",
              questionId: input.questionId,
              question: input.question,
            });
            await options.bridge.reportBlocker(input);
          },
        },
        ...(options.fs === undefined ? {} : { fs: options.fs }),
        ...(options.commands === undefined ? {} : { commands: options.commands }),
        ...(lease === undefined ? {} : { lease }),
      });
      const session = await options.sessionFactory({
        cwd: lease?.overlayPath ?? ".",
        systemPrompt: context.systemPrompt,
        tools,
      });
      const handle: AgentHandle = {
        agentId,
        runId: request.runId,
        nodeId: request.nodeId,
        role: request.role,
        sessionId: session.sessionId,
        toolProfile: request.toolProfile,
        capabilityTokenId: token.tokenId,
        adapter: "control-plane-session",
        adapterVersion: CAPABILITIES.version,
        spawnedAt: now,
        ...(request.workspaceLeaseId === undefined
          ? {}
          : { workspaceLeaseId: request.workspaceLeaseId }),
      };
      sessions.set(agentId, session);
      store.set(handle);
      await session.prompt(context.userPrompt);
      return handle;
    },
    async consume(handle) {
      const session = sessions.get(handle.agentId);
      if (session === undefined) {
        return { outcome: "lost", reason: "session missing" };
      }
      await session.waitForIdle();
      return results.get(handle.agentId) ?? { outcome: "failed", reason: "no artifact submitted" };
    },
    async steer(handle, message) {
      const session = sessions.get(handle.agentId);
      if (session === undefined) {
        throw new Error("session missing");
      }
      await session.steer(message);
    },
    async stop(handle) {
      const session = sessions.get(handle.agentId);
      if (session === undefined) {
        return;
      }
      await session.abort();
      session.dispose();
      sessions.delete(handle.agentId);
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
