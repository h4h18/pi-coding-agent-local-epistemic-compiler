import type {
  AgentId,
  AgentRole,
  ArtifactReference,
  CapabilityToken,
  NodeStatus,
  SpawnRequest,
  ToolProfile,
  WorkspaceLease,
} from "@pi-hec/contracts";

export type RuntimeCapabilities = {
  adapter: "control-plane-session" | "direct-provider-loop" | "pi-subagents";
  version: string;
  steer: boolean;
  resume: boolean;
  stop: boolean;
  nestedDelegation: false;
  fallbackSubagent: "none";
};

export type AgentHandle = {
  agentId: AgentId;
  runId: SpawnRequest["runId"];
  nodeId: string;
  role: AgentRole;
  sessionId: string;
  toolProfile: ToolProfile;
  capabilityTokenId: CapabilityToken["tokenId"];
  workspaceLeaseId?: NonNullable<SpawnRequest["workspaceLeaseId"]>;
  adapter: RuntimeCapabilities["adapter"];
  adapterVersion: string;
  spawnedAt: string;
};

export type AgentResult =
  | {
      outcome: "artifact";
      envelope: unknown;
    }
  | {
      outcome: "blocker";
      questionId: string;
      question: string;
    }
  | {
      outcome: "failed";
      reason: string;
    }
  | {
      outcome: "lost";
      reason: string;
    };

export type RuntimeSnapshot = {
  runId: AgentHandle["runId"];
  handles: readonly AgentHandle[];
  nodeStatuses: Readonly<Record<string, NodeStatus>>;
};

export type AgentRuntime = {
  capabilities(): Promise<RuntimeCapabilities>;
  spawn(request: SpawnRequest): Promise<AgentHandle>;
  consume(handle: AgentHandle): Promise<AgentResult>;
  steer(handle: AgentHandle, message: string): Promise<void>;
  stop(handle: AgentHandle): Promise<void>;
  reconcile(runId: AgentHandle["runId"]): Promise<RuntimeSnapshot>;
};

export type BridgePorts = {
  requestContext: (input: {
    token: CapabilityToken;
    query: string;
  }) => Promise<{ text: string; untrusted: boolean }>;
  submitArtifact: (input: {
    token: CapabilityToken;
    envelope: unknown;
  }) => Promise<{ accepted: boolean; issues: readonly string[] }>;
  reportProgress: (input: { token: CapabilityToken; message: string }) => Promise<void>;
  reportBlocker: (input: {
    token: CapabilityToken;
    questionId: string;
    question: string;
  }) => Promise<void>;
};

export type ScopedFsPorts = {
  readFile: (lease: WorkspaceLease, path: string) => Promise<string>;
  listDirectory: (lease: WorkspaceLease, path: string) => Promise<readonly string[]>;
  grepRepository: (
    lease: WorkspaceLease,
    pattern: string,
  ) => Promise<readonly { path: string; line: number; text: string }[]>;
  findFiles: (lease: WorkspaceLease, glob: string) => Promise<readonly string[]>;
  inspectSymbol: (
    lease: WorkspaceLease,
    symbol: string,
  ) => Promise<readonly { path: string; name: string }[]>;
  writeScopedFile: (lease: WorkspaceLease, path: string, contents: string) => Promise<void>;
  editScopedFile: (
    lease: WorkspaceLease,
    path: string,
    oldText: string,
    newText: string,
  ) => Promise<void>;
  removeScopedFile: (lease: WorkspaceLease, path: string) => Promise<void>;
};

export type CommandPorts = {
  exec: (input: {
    lease: WorkspaceLease;
    kind: "readonly" | "git-read" | "build" | "test" | "lint" | "formatter";
    executable: string;
    args: readonly string[];
  }) => Promise<{
    exitCode: number;
    stdoutDigest: string;
    stderrDigest: string;
    durationMs: number;
  }>;
};

export type HeadlessSession = {
  sessionId: string;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: { type: string; text?: string }) => void): () => void;
  dispose(): void;
};

export type SessionFactory = (input: {
  cwd: string;
  systemPrompt: string;
  tools: readonly CustomToolDefinition[];
}) => Promise<HeadlessSession>;

export type CustomToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: unknown; details: unknown }>;
};

export type AssembledContext = {
  systemPrompt: string;
  userPrompt: string;
  inputArtifacts: readonly ArtifactReference[];
  untrustedRag: boolean;
};

export type LiveHandleStore = {
  get(agentId: AgentId): AgentHandle | undefined;
  set(handle: AgentHandle): void;
  delete(agentId: AgentId): void;
  list(runId: AgentHandle["runId"]): readonly AgentHandle[];
};
