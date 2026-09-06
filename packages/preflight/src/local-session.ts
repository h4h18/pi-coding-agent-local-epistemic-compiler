import { Compile } from "typebox/compile";
import type { Static } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  EpistemicAuditRequestSchema,
  EpistemicAuditResultSchema,
  EvidenceActionProposalSchema,
  EvidenceFrontierRequestSchema,
  EvidenceLinkRequestSchema,
  EvidenceLinkResultSchema,
  LocalEvidenceProposalSchema,
  RetrievalQueryRequestSchema,
  RetrievalQueryResultSchema,
  SemanticVerificationRequestSchema,
  SemanticVerificationResultSchema,
  evidenceToolNames,
} from "@pi-hec/contracts";
import {
  LocalAnalystFailure,
  createEmptyAclRestrictedAgentDir,
  createIsolatedLocalRuntime,
  requireExactPinnedLocalModel,
  type InventorySessionMeasurement,
  type IsolatedLocalRuntime,
  type LocalDeploymentSeal,
} from "@pi-hec/models";
import { persistAnalystTrace, sanitizeLocalText } from "./tools/scanner.js";
import { createEvidenceTools, type EvidenceToolDependencies } from "./tools/evidence-tools.js";

const QUERY_REQUEST = Compile(RetrievalQueryRequestSchema);
const QUERY_RESULT = Compile(RetrievalQueryResultSchema);
const ACTION_REQUEST = Compile(EvidenceFrontierRequestSchema);
const ACTION_RESULT = Compile(EvidenceActionProposalSchema);
const LINK_REQUEST = Compile(EvidenceLinkRequestSchema);
const LINK_RESULT = Compile(EvidenceLinkResultSchema);
const AUDIT_REQUEST = Compile(EpistemicAuditRequestSchema);
const AUDIT_RESULT = Compile(EpistemicAuditResultSchema);
const REVIEW_REQUEST = Compile(SemanticVerificationRequestSchema);
const REVIEW_RESULT = Compile(SemanticVerificationResultSchema);
const PROPOSAL = Compile(LocalEvidenceProposalSchema);

export const EVIDENCE_COMPILER_SYSTEM_PROMPT =
  "You are the Pi HEC evidence-compiler role contract. You are a read-only local analyst. " +
  "Use only the registered evidence tools. Never emit patches, commands, file bytes, shell, or cloud instructions. " +
  "Return typed JSON matching the requested schema. Reconstruct retrieval actions only via evidence_submit_actions " +
  "and audits via evidence_submit_audit. reviewCandidateAgainstEvidence may only open evidence obligations.";

export type LocalSemanticAdapter = {
  expandRetrievalQueries(
    request: Static<typeof RetrievalQueryRequestSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof RetrievalQueryResultSchema>>;
  proposeEvidenceActions(
    request: Static<typeof EvidenceFrontierRequestSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof EvidenceActionProposalSchema>>;
  linkEvidence(
    request: Static<typeof EvidenceLinkRequestSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof EvidenceLinkResultSchema>>;
  identifyUnknownsAndConflicts(
    request: Static<typeof EpistemicAuditRequestSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof EpistemicAuditResultSchema>>;
  reviewCandidateAgainstEvidence(
    request: Static<typeof SemanticVerificationRequestSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof SemanticVerificationResultSchema>>;
  dispose(): Promise<void>;
};

export function assertExactEvidenceToolNames(names: readonly string[]): void {
  const expected = [...evidenceToolNames].sort();
  const actual = [...names].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new Error(`registered custom-tool name set must exactly equal evidenceToolNames, got ${actual.join(",")}`);
  }
}

export function createControlledResourceLoader(): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => EVIDENCE_COMPILER_SYSTEM_PROMPT,
    getSystemPromptSource: () => ({ path: "hec:evidence-compiler-role-contract" }),
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: () => Promise.resolve(),
  };
}

export type LocalAnalystSessionInput = {
  snapshotRoot: string;
  seal: LocalDeploymentSeal;
  toolDeps: EvidenceToolDependencies;
  modelRuntime?: IsolatedLocalRuntime["modelRuntime"];
  agentDir?: string;
};

export type LocalAnalystSession = {
  session: AgentSession;
  runtime: IsolatedLocalRuntime;
  tools: ToolDefinition[];
  resourceLoader: ResourceLoader;
};

async function resolveRuntime(
  modelRuntime: IsolatedLocalRuntime["modelRuntime"] | undefined,
  seal: LocalDeploymentSeal,
): Promise<IsolatedLocalRuntime> {
  if (modelRuntime === undefined) {
    return createIsolatedLocalRuntime(seal);
  }
  return {
    modelRuntime,
    credentials: new InMemoryCredentialStore(),
    model: await requireExactPinnedLocalModel(modelRuntime, seal),
    seal,
  };
}

export async function createLocalAnalystSession(input: LocalAnalystSessionInput): Promise<LocalAnalystSession> {
  const isolated = await resolveRuntime(input.modelRuntime, input.seal);
  const tools = createEvidenceTools(input.toolDeps);
  assertExactEvidenceToolNames(tools.map((tool) => tool.name));
  const agentDir = input.agentDir ?? (await createEmptyAclRestrictedAgentDir());
  const resourceLoader = createControlledResourceLoader();
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: input.snapshotRoot,
    agentDir,
    noTools: "builtin",
    tools: [...evidenceToolNames],
    customTools: tools,
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
    model: isolated.model,
    scopedModels: [{ model: isolated.model, thinkingLevel: "high" }],
    modelRuntime: isolated.modelRuntime,
  });
  return { session, runtime: isolated, tools, resourceLoader };
}

export function measureSessionInventory(session: LocalAnalystSession): InventorySessionMeasurement {
  const { resourceLoader } = session;
  return {
    agentsFileCount: resourceLoader.getAgentsFiles().agentsFiles.length,
    extensionCount: resourceLoader.getExtensions().extensions.length,
    skillCount: resourceLoader.getSkills().skills.length,
    promptCount: resourceLoader.getPrompts().prompts.length,
    themeCount: resourceLoader.getThemes().themes.length,
    appendPromptCount: resourceLoader.getAppendSystemPrompt().length,
    activeToolNames: [...session.session.getActiveToolNames()],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(text: string): unknown {
  persistAnalystTrace(text);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("local analyst did not return a JSON object");
  }
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }
    if ((block.type === "text" || block.type === "output_text") && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function lastAssistantPayload(session: AgentSession): { text: string; errorMessage: string | undefined } {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    return {
      text: textFromContent(message.content),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    };
  }
  return { text: "", errorMessage: undefined };
}

function bindSessionAbort(session: AgentSession, signal: AbortSignal): () => void {
  const onAbort = (): void => {
    void session.abort();
  };
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  signal.addEventListener("abort", onAbort);
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

async function promptLane(session: AgentSession, lane: string, payload: unknown, signal: AbortSignal): Promise<string> {
  const body = `HEC_LANE:${lane}\n${JSON.stringify(payload)}`;
  persistAnalystTrace(body);
  const unbind = bindSessionAbort(session, signal);
  try {
    signal.throwIfAborted();
    try {
      await session.prompt(body, { expandPromptTemplates: false });
      await session.waitForIdle();
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`local analyst prompt failed for ${lane}: ${reason}`);
    }
    signal.throwIfAborted();
    const payloadOut = lastAssistantPayload(session);
    if (
      payloadOut.text.length === 0 &&
      payloadOut.errorMessage !== undefined &&
      payloadOut.errorMessage.length > 0
    ) {
      throw new Error(`local analyst stream error for ${lane}: ${payloadOut.errorMessage}`);
    }
    return payloadOut.text;
  } finally {
    unbind();
  }
}

function proposalsFromUnknown(values: readonly unknown[]): Static<typeof LocalEvidenceProposalSchema>[] {
  const proposals: Static<typeof LocalEvidenceProposalSchema>[] = [];
  for (const value of values) {
    if (!PROPOSAL.Check(value)) {
      throw new Error("submitted audit proposal failed schema validation");
    }
    proposals.push(value);
  }
  return proposals;
}

function sanitizeProposal(
  proposal: Static<typeof LocalEvidenceProposalSchema>,
): Static<typeof LocalEvidenceProposalSchema> {
  return {
    ...proposal,
    statement: sanitizeLocalText(proposal.statement),
    requestedReproductionActions: sanitizeActions(proposal.requestedReproductionActions),
  };
}

function sanitizeQueries(
  result: Static<typeof RetrievalQueryResultSchema>,
): Static<typeof RetrievalQueryResultSchema> {
  return {
    ...result,
    queries: result.queries.map((item) => ({
      ...item,
      query: sanitizeLocalText(item.query),
      entityHints: item.entityHints.map((hint) => sanitizeLocalText(hint)),
    })),
  };
}

function sanitizeActions(
  actions: Static<typeof EvidenceActionProposalSchema>["actions"],
): Static<typeof EvidenceActionProposalSchema>["actions"] {
  return actions.map((action) => ({ ...action, query: sanitizeLocalText(action.query) }));
}

function sanitizeLinkResult(
  result: Static<typeof EvidenceLinkResultSchema>,
): Static<typeof EvidenceLinkResultSchema> {
  return {
    ...result,
    proposedEvidence: result.proposedEvidence.map(sanitizeProposal),
  };
}

function sanitizeFindings(
  result: Static<typeof SemanticVerificationResultSchema>,
): Static<typeof SemanticVerificationResultSchema> {
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      statement: sanitizeLocalText(finding.statement),
    })),
  };
}

export type LocalSemanticAdapterInput = {
  snapshotRoot: string;
  seal: LocalDeploymentSeal | undefined;
  toolDeps: EvidenceToolDependencies;
  modelRuntime?: IsolatedLocalRuntime["modelRuntime"];
};

export async function createLocalSemanticAdapter(input: LocalSemanticAdapterInput): Promise<LocalSemanticAdapter> {
  const { seal, ...sessionInput } = input;
  if (seal === undefined) {
    throw new LocalAnalystFailure(
      "LOCAL_DEPLOYMENT_SEAL_MISSING",
      "local semantic adapter requires a signed loopback deployment seal",
    );
  }
  const created = await createLocalAnalystSession({ ...sessionInput, seal });
  const { session } = created;
  return {
    async expandRetrievalQueries(request, signal) {
      if (!QUERY_REQUEST.Check(request)) {
        throw new Error("RetrievalQueryRequest failed schema validation");
      }
      const parsed = extractJsonObject(await promptLane(session, "QUERY", request, signal));
      if (!QUERY_RESULT.Check(parsed)) {
        throw new Error("RetrievalQueryResult failed schema validation");
      }
      const sanitized = sanitizeQueries(parsed);
      if (!QUERY_RESULT.Check(sanitized)) {
        throw new Error("RetrievalQueryResult failed schema validation after sanitizer");
      }
      return sanitized;
    },
    async proposeEvidenceActions(request, signal) {
      if (!ACTION_REQUEST.Check(request)) {
        throw new Error("EvidenceFrontierRequest failed schema validation");
      }
      const captured: Static<typeof EvidenceActionProposalSchema>["actions"] = [];
      const original = input.toolDeps.proposalSink.persistActions;
      try {
        input.toolDeps.proposalSink.persistActions = (actions) => {
          captured.push(...actions);
          original(actions);
        };
        await promptLane(session, "ACTIONS", request, signal);
      } finally {
        input.toolDeps.proposalSink.persistActions = original;
      }
      const result = {
        schemaVersion: 1 as const,
        evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
        actions: sanitizeActions(captured),
        fixedPointClaimed: captured.length === 0,
      };
      if (!ACTION_RESULT.Check(result)) {
        throw new Error("EvidenceActionProposal failed schema validation");
      }
      return result;
    },
    async linkEvidence(request, signal) {
      if (!LINK_REQUEST.Check(request)) {
        throw new Error("EvidenceLinkRequest failed schema validation");
      }
      const parsed = extractJsonObject(await promptLane(session, "LINK", request, signal));
      if (!LINK_RESULT.Check(parsed)) {
        throw new Error("EvidenceLinkResult failed schema validation");
      }
      const sanitized = sanitizeLinkResult(parsed);
      if (!LINK_RESULT.Check(sanitized)) {
        throw new Error("EvidenceLinkResult failed schema validation after sanitizer");
      }
      return sanitized;
    },
    async identifyUnknownsAndConflicts(request, signal) {
      if (!AUDIT_REQUEST.Check(request)) {
        throw new Error("EpistemicAuditRequest failed schema validation");
      }
      let capturedUnknowns: readonly unknown[] = [];
      let capturedConflicts: readonly unknown[] = [];
      const original = input.toolDeps.proposalSink.persistAudit;
      try {
        input.toolDeps.proposalSink.persistAudit = (audit) => {
          capturedUnknowns = audit.unknowns;
          capturedConflicts = audit.conflicts;
          original(audit);
        };
        await promptLane(session, "AUDIT", request, signal);
      } finally {
        input.toolDeps.proposalSink.persistAudit = original;
      }
      const proposedUnknowns = proposalsFromUnknown(capturedUnknowns).map(sanitizeProposal);
      const proposedConflicts = proposalsFromUnknown(capturedConflicts).map(sanitizeProposal);
      const result = {
        schemaVersion: 1 as const,
        evidenceGraphObjectDigest: request.evidenceGraphObjectDigest,
        proposedUnknowns,
        proposedConflicts,
        closureCheckSuggestions: [],
      };
      if (!AUDIT_RESULT.Check(result)) {
        throw new Error("EpistemicAuditResult failed schema validation");
      }
      return result;
    },
    async reviewCandidateAgainstEvidence(request, signal) {
      if (!REVIEW_REQUEST.Check(request)) {
        throw new Error("SemanticVerificationRequest failed schema validation");
      }
      const parsed = extractJsonObject(await promptLane(session, "REVIEW", request, signal));
      if (!REVIEW_RESULT.Check(parsed)) {
        throw new Error("SemanticVerificationResult failed schema validation");
      }
      if (isRecord(parsed) && ("verdict" in parsed || "status" in parsed || "admissible" in parsed)) {
        throw new Error("semantic verification result must not carry verdict fields");
      }
      const sanitized = sanitizeFindings(parsed);
      if (!REVIEW_RESULT.Check(sanitized)) {
        throw new Error("SemanticVerificationResult failed schema validation after sanitizer");
      }
      if (isRecord(sanitized) && ("verdict" in sanitized || "status" in sanitized || "admissible" in sanitized)) {
        throw new Error("semantic verification result must not carry verdict fields");
      }
      return sanitized;
    },
    async dispose() {
      await session.abort();
      session.dispose();
    },
  };
}
