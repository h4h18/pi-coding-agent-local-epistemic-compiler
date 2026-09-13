import { asAgentId, randomPrefixedUuidV7, type SpawnRequest } from "@pi-hec/contracts";
import { mintCapabilityToken } from "../capability.js";
import { assembleWorkerContext, withAgentBinding } from "../context.js";
import { cancelBusyInferenceSlots } from "../inference-slots.js";
import { createMemoryHandleStore } from "../memory-store.js";
import {
  overlayBranchFor,
  overlayPathFor,
  provisionWorkspaceOverlay,
  releaseWorkspaceOverlay,
  sweepOrphanOverlays,
  type OverlayPorts,
} from "../overlay-lifecycle.js";
import { abortAndDispose } from "../session-lifecycle.js";
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
  overlayRoot?: string;
  inferenceOrigin?: string;
  overlayPorts?: OverlayPorts;
  fetchImpl?: typeof fetch;
  abortTimeoutMs?: number;
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
  const overlays = new Map<string, string>();
  const inflightPrompts = new Map<string, Promise<void>>();

  const abortGeneration = (agentId: string): void => {
    queueMicrotask(() => {
      void sessions
        .get(agentId)
        ?.abort()
        .catch(() => undefined);
    });
  };

  const stopHandle = async (handle: AgentHandle): Promise<void> => {
    const session = sessions.get(handle.agentId);
    if (session !== undefined) {
      await abortAndDispose(session, options.abortTimeoutMs);
    }
    inflightPrompts.delete(handle.agentId);
    sessions.delete(handle.agentId);
    store.delete(handle.agentId);
    results.delete(handle.agentId);
    const overlayPath = overlays.get(handle.agentId);
    overlays.delete(handle.agentId);
    if (overlayPath !== undefined) {
      releaseWorkspaceOverlay(overlayPath, options.overlayPorts);
    }
    if (sessions.size === 0 && options.inferenceOrigin !== undefined) {
      await cancelBusyInferenceSlots(options.inferenceOrigin, options.fetchImpl ?? fetch);
    }
  };

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
      const overlayPath =
        lease?.overlayPath ??
        (options.overlayRoot === undefined
          ? undefined
          : overlayPathFor(options.overlayRoot, request.runId, request.nodeId));
      if (overlayPath !== undefined) {
        provisionWorkspaceOverlay({
          overlayPath,
          branch: lease?.branch ?? overlayBranchFor(request.runId, request.nodeId),
          ...(lease === undefined || lease.baseCommit === "base" ? {} : { baseCommit: lease.baseCommit }),
          ...(options.overlayPorts === undefined ? {} : { ports: options.overlayPorts }),
        });
        overlays.set(agentId, overlayPath);
      }
      const tools = createRoleTools({
        token,
        now: options.now,
        bridge: {
          ...options.bridge,
          submitArtifact: async (input) => {
            const submitted = await options.bridge.submitArtifact(input);
            if (submitted.accepted) {
              results.set(agentId, { outcome: "artifact", envelope: input.envelope });
              abortGeneration(agentId);
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
            abortGeneration(agentId);
          },
        },
        ...(options.fs === undefined ? {} : { fs: options.fs }),
        ...(options.commands === undefined ? {} : { commands: options.commands }),
        ...(lease === undefined ? {} : { lease }),
      });
      const session = await options.sessionFactory({
        cwd: overlayPath ?? ".",
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
      const promptDone = session.prompt(context.userPrompt).then(
        () => undefined,
        (error: unknown) => {
          if (!results.has(agentId)) {
            results.set(agentId, {
              outcome: "failed",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      inflightPrompts.set(agentId, promptDone);
      return handle;
    },
    async consume(handle) {
      const known = results.get(handle.agentId);
      const session = sessions.get(handle.agentId);
      if (session === undefined) {
        return known ?? { outcome: "lost", reason: "session missing" };
      }
      try {
        const pending = inflightPrompts.get(handle.agentId);
        if (pending !== undefined) {
          await pending;
        }
        await session.waitForIdle();
      } catch {
        return results.get(handle.agentId) ?? { outcome: "failed", reason: "session aborted" };
      }
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
      await stopHandle(handle);
    },
    async stopAll() {
      const live = [...sessions.keys()].map((agentId) => store.get(agentId as AgentHandle["agentId"]));
      for (const handle of live) {
        if (handle !== undefined) {
          await stopHandle(handle);
        }
      }
      sessions.clear();
      if (options.overlayRoot !== undefined) {
        sweepOrphanOverlays({
          root: options.overlayRoot,
          keepOverlayPaths: new Set(overlays.values()),
          ...(options.overlayPorts === undefined ? {} : { ports: options.overlayPorts }),
        });
      }
      if (options.inferenceOrigin !== undefined) {
        await cancelBusyInferenceSlots(options.inferenceOrigin, options.fetchImpl ?? fetch);
      }
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
