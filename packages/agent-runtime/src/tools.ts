import { Compile } from "typebox/compile";
import {
  WorkerArtifactEnvelopeSchema,
  type CapabilityToken,
  type ToolProfile,
  type WorkerArtifactEnvelope,
  type WorkspaceLease,
} from "@pi-hec/contracts";
import { validateWorkerEnvelope } from "@pi-hec/domain";
import { assertToken, CapabilityError } from "./capability.js";
import type { BridgePorts, CommandPorts, CustomToolDefinition, ScopedFsPorts } from "./types.js";
import { assertLeaseWritable, resolveInsideLease, WorkspaceIsolationError } from "./workspace.js";

const ENVELOPE = Compile(WorkerArtifactEnvelopeSchema);
const READ_ONLY_COMMANDS = new Set(["readonly", "git-read"]);
const WRITE_COMMANDS = new Set(["build", "test", "lint", "formatter"]);
export const FORBIDDEN_TOOL_NAMES: readonly string[] = [
  "spawn_agent",
  "delegate",
  "bash",
  "write",
  "edit",
];

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("tool params must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityError(`${field} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CapabilityError(`${field} must be a string array`);
  }
  return value as string[];
}

export function toolNamesForProfile(profile: ToolProfile): readonly string[] {
  const bridge = ["request_context", "submit_artifact", "report_progress", "report_blocker"];
  const read = [
    "read_file",
    "list_directory",
    "grep_repository",
    "find_files",
    "inspect_symbol",
    "exec_git_read",
    "exec_readonly",
  ];
  switch (profile) {
    case "read":
      return [...read, ...bridge];
    case "review":
      return [...read, "request_context", "submit_artifact", "report_blocker"];
    case "write":
      return [
        "read_file",
        "list_directory",
        "grep_repository",
        "find_files",
        "write_scoped_file",
        "edit_scoped_file",
        "remove_scoped_file",
        "exec_build",
        "exec_test",
        "exec_lint",
        "exec_formatter",
        "submit_artifact",
        "report_blocker",
      ];
    default: {
      const exhaustive: never = profile;
      throw new Error(`unhandled tool profile ${String(exhaustive)}`);
    }
  }
}

export function createRoleTools(input: {
  token: CapabilityToken;
  now: () => string;
  secret?: Uint8Array;
  mac?: string;
  lease?: WorkspaceLease;
  bridge: BridgePorts;
  fs?: ScopedFsPorts;
  commands?: CommandPorts;
}): CustomToolDefinition[] {
  const names = new Set(toolNamesForProfile(input.token.toolProfile));
  const tools: CustomToolDefinition[] = [];

  const scoped = async (
    relative: string,
    write: boolean,
  ): Promise<{ lease: WorkspaceLease; path: string }> => {
    if (input.lease === undefined) {
      throw new WorkspaceIsolationError("lease required");
    }
    if (write) {
      assertLeaseWritable(input.lease);
    }
    return { lease: input.lease, path: resolveInsideLease(input.lease, relative) };
  };

  if (names.has("request_context")) {
    tools.push({
      name: "request_context",
      label: "Request context",
      description: "Request additional control-assembled context for this node.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
      execute: async (_id, params) => {
        assertToken(input.token, {
          runId: input.token.runId,
          nodeId: input.token.nodeId,
          agentId: input.token.agentId,
          now: input.now(),
          ...(input.secret === undefined ? {} : { secret: input.secret }),
          ...(input.mac === undefined ? {} : { mac: input.mac }),
        });
        const query = asString(asRecord(params).query, "query");
        const result = await input.bridge.requestContext({ token: input.token, query });
        return { content: result.text, details: { untrusted: result.untrusted } };
      },
    });
  }
  if (names.has("submit_artifact")) {
    tools.push({
      name: "submit_artifact",
      label: "Submit artifact",
      description: "Submit the typed terminal artifact for this node. This is the authoritative output.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["envelope"],
        properties: { envelope: { type: "object" } },
      },
      execute: async (_id, params) => {
        assertToken(input.token, {
          runId: input.token.runId,
          nodeId: input.token.nodeId,
          agentId: input.token.agentId,
          now: input.now(),
        });
        const envelope = asRecord(params).envelope;
        if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
          return {
            content: "envelope must be an object",
            details: { accepted: false, issues: ["envelope must be an object"] },
          };
        }
          if (!ENVELOPE.Check(envelope)) {
            const details = ENVELOPE.Errors(envelope)
              .slice(0, 8)
              .map((error) => `${error.instancePath || "/"}: ${error.message}`);
            return {
              content: details.join("\n") || "envelope failed WorkerArtifactEnvelope schema",
              details: {
                accepted: false,
                issues:
                  details.length === 0
                    ? ["envelope failed WorkerArtifactEnvelope schema"]
                    : details,
              },
            };
          }
        const typed = envelope as WorkerArtifactEnvelope;
        if (
          !input.token.allowedArtifactTypes.includes(
            typed.artifactType as CapabilityToken["allowedArtifactTypes"][number],
          )
        ) {
          return {
            content: `artifactType ${typed.artifactType} is not allowed`,
            details: {
              accepted: false,
              issues: [`artifactType ${typed.artifactType} is not allowed`],
            },
          };
        }
        const validated = validateWorkerEnvelope(typed, {
          runId: input.token.runId,
          nodeId: input.token.nodeId,
          agentId: input.token.agentId,
          artifactType: typed.artifactType,
        });
        if (!validated.ok) {
          const issues = validated.issues.map((issue) => `${issue.path}: ${issue.message}`);
          return { content: issues.join("\n"), details: { accepted: false, issues } };
        }
        const result = await input.bridge.submitArtifact({ token: input.token, envelope: typed });
        return { content: result.accepted ? "accepted" : result.issues.join("\n"), details: result };
      },
    });
  }
  if (names.has("report_progress")) {
    tools.push({
      name: "report_progress",
      label: "Report progress",
      description: "Report non-authoritative progress to control.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message"],
        properties: { message: { type: "string" } },
      },
      execute: async (_id, params) => {
        const message = asString(asRecord(params).message, "message");
        await input.bridge.reportProgress({ token: input.token, message });
        return { content: "ok", details: {} };
      },
    });
  }
  if (names.has("report_blocker")) {
    tools.push({
      name: "report_blocker",
      label: "Report blocker",
      description: "Report a true blocker that requires user input or stops the node.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "question"],
        properties: { questionId: { type: "string" }, question: { type: "string" } },
      },
      execute: async (_id, params) => {
        const record = asRecord(params);
        await input.bridge.reportBlocker({
          token: input.token,
          questionId: asString(record.questionId, "questionId"),
          question: asString(record.question, "question"),
        });
        return { content: "blocker recorded", details: {} };
      },
    });
  }

  const fs = input.fs;
  if (fs !== undefined) {
    if (names.has("read_file")) {
      tools.push({
        name: "read_file",
        label: "Read file",
        description: "Read a file inside the snapshot overlay.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        execute: async (_id, params) => {
          const scopedPath = await scoped(asString(asRecord(params).path, "path"), false);
          const text = await fs.readFile(scopedPath.lease, asString(asRecord(params).path, "path"));
          return { content: text, details: {} };
        },
      });
    }
    if (names.has("list_directory")) {
      tools.push({
        name: "list_directory",
        label: "List directory",
        description: "List a directory inside the snapshot overlay.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        execute: async (_id, params) => {
          const relative = asString(asRecord(params).path, "path");
          await scoped(relative, false);
          return { content: (await fs.listDirectory(input.lease as WorkspaceLease, relative)).join("\n"), details: {} };
        },
      });
    }
    if (names.has("grep_repository")) {
      tools.push({
        name: "grep_repository",
        label: "Grep repository",
        description: "Search file contents inside the overlay.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["pattern"],
          properties: { pattern: { type: "string" } },
        },
        execute: async (_id, params) => {
          if (input.lease === undefined) {
            throw new WorkspaceIsolationError("lease required");
          }
          const hits = await fs.grepRepository(input.lease, asString(asRecord(params).pattern, "pattern"));
          return { content: JSON.stringify(hits), details: hits };
        },
      });
    }
    if (names.has("find_files")) {
      tools.push({
        name: "find_files",
        label: "Find files",
        description: "Find files by glob inside the overlay.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["glob"],
          properties: { glob: { type: "string" } },
        },
        execute: async (_id, params) => {
          if (input.lease === undefined) {
            throw new WorkspaceIsolationError("lease required");
          }
          const files = await fs.findFiles(input.lease, asString(asRecord(params).glob, "glob"));
          return { content: files.join("\n"), details: files };
        },
      });
    }
    if (names.has("inspect_symbol")) {
      tools.push({
        name: "inspect_symbol",
        label: "Inspect symbol",
        description: "Inspect a symbol inside the overlay index.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["symbol"],
          properties: { symbol: { type: "string" } },
        },
        execute: async (_id, params) => {
          if (input.lease === undefined) {
            throw new WorkspaceIsolationError("lease required");
          }
          const hits = await fs.inspectSymbol(input.lease, asString(asRecord(params).symbol, "symbol"));
          return { content: JSON.stringify(hits), details: hits };
        },
      });
    }
    if (names.has("write_scoped_file")) {
      tools.push({
        name: "write_scoped_file",
        label: "Write scoped file",
        description: "Write a file inside the verified writer lease.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path", "contents"],
          properties: { path: { type: "string" }, contents: { type: "string" } },
        },
        execute: async (_id, params) => {
          const record = asRecord(params);
          const relative = asString(record.path, "path");
          await scoped(relative, true);
          await fs.writeScopedFile(input.lease as WorkspaceLease, relative, asString(record.contents, "contents"));
          return { content: "written", details: {} };
        },
      });
    }
    if (names.has("edit_scoped_file")) {
      tools.push({
        name: "edit_scoped_file",
        label: "Edit scoped file",
        description: "Replace text in a file inside the verified writer lease.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path", "oldText", "newText"],
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
        },
        execute: async (_id, params) => {
          const record = asRecord(params);
          const relative = asString(record.path, "path");
          await scoped(relative, true);
          await fs.editScopedFile(
            input.lease as WorkspaceLease,
            relative,
            asString(record.oldText, "oldText"),
            asString(record.newText, "newText"),
          );
          return { content: "edited", details: {} };
        },
      });
    }
    if (names.has("remove_scoped_file")) {
      tools.push({
        name: "remove_scoped_file",
        label: "Remove scoped file",
        description: "Remove a file inside the verified writer lease.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        execute: async (_id, params) => {
          const relative = asString(asRecord(params).path, "path");
          await scoped(relative, true);
          await fs.removeScopedFile(input.lease as WorkspaceLease, relative);
          return { content: "removed", details: {} };
        },
      });
    }
  }

  const commands = input.commands;
  if (commands !== undefined && input.lease !== undefined) {
    const execTool = (
      name: string,
      kind: "readonly" | "git-read" | "build" | "test" | "lint" | "formatter",
    ): CustomToolDefinition => ({
      name,
      label: name,
      description: `Execute allowlisted ${kind} command via the command broker.`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["executable", "args"],
        properties: {
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
      },
      execute: async (_id, params) => {
        if (WRITE_COMMANDS.has(kind)) {
          assertLeaseWritable(input.lease as WorkspaceLease);
        }
        if (READ_ONLY_COMMANDS.has(kind) === false && input.token.toolProfile !== "write") {
          throw new CapabilityError("command requires write profile");
        }
        const record = asRecord(params);
        const result = await commands.exec({
          lease: input.lease as WorkspaceLease,
          kind,
          executable: asString(record.executable, "executable"),
          args: asStringArray(record.args, "args"),
        });
        return { content: JSON.stringify(result), details: result };
      },
    });
    if (names.has("exec_readonly")) {
      tools.push(execTool("exec_readonly", "readonly"));
    }
    if (names.has("exec_git_read")) {
      tools.push(execTool("exec_git_read", "git-read"));
    }
    if (names.has("exec_build")) {
      tools.push(execTool("exec_build", "build"));
    }
    if (names.has("exec_test")) {
      tools.push(execTool("exec_test", "test"));
    }
    if (names.has("exec_lint")) {
      tools.push(execTool("exec_lint", "lint"));
    }
    if (names.has("exec_formatter")) {
      tools.push(execTool("exec_formatter", "formatter"));
    }
  }

  return tools.filter((tool) => names.has(tool.name) && !FORBIDDEN_TOOL_NAMES.includes(tool.name));
}

export function assertNoConfusedDeputyTools(names: readonly string[]): void {
  const forbidden = names.filter((name) => FORBIDDEN_TOOL_NAMES.includes(name));
  if (forbidden.length > 0) {
    throw new CapabilityError(`forbidden tools: ${forbidden.join(",")}`);
  }
}
