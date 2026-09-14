import { Compile } from "typebox/compile";
import { jsonBody, type ControlPlaneClient } from "@pi-hec/client";
import type {
  ApiError,
  BrokerRequest,
  BrokerResponse,
  OperationProjection,
  RunAgentsPage,
  RunId,
  RunProjection,
} from "@pi-hec/contracts";
import {
  ApiErrorSchema,
  OperationProjectionSchema,
  RunAgentsPageSchema,
  RunEventPageSchema,
  RunProjectionSchema,
  asRunId,
  randomPrefixedUuidV7,
  sha256Utf8,
} from "@pi-hec/contracts";
import type { BrokerPort } from "../../../../client/apps/pi-extension/src/broker-client.js";

const RUN = Compile(RunProjectionSchema);
const AGENTS = Compile(RunAgentsPageSchema);
const EVENTS = Compile(RunEventPageSchema);
const OPERATION = Compile(OperationProjectionSchema);
const ERROR = Compile(ApiErrorSchema);

export type ControlPlaneBrokerWorld = {
  clock(): string;
  broker: ControlPlaneClient;
  projectId: string;
  workspaceId: string;
};

function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8"));
}

function internalError(requestId: string, message: string): BrokerResponse {
  return {
    requestId,
    outcome: "ERROR",
    error: {
      schemaVersion: 1,
      code: "INTERNAL",
      message,
      retryClass: "ambiguous",
    },
  };
}

function httpError(requestId: string, body: Buffer): BrokerResponse {
  const parsed: unknown = parseJson(body);
  if (ERROR.Check(parsed)) {
    return { requestId, outcome: "ERROR", error: parsed };
  }
  return internalError(requestId, "control-plane error");
}

export class ControlPlaneBroker implements BrokerPort {
  readonly brokerInstanceId = "broker-1";
  readonly connectionId = "conn-golden-eval";
  lastRun: RunProjection | undefined;
  lastAgents: RunAgentsPage | undefined;
  lastOperation: OperationProjection | undefined;
  lastError: ApiError | undefined;

  constructor(private readonly world: ControlPlaneBrokerWorld) {}

  async request(body: BrokerRequest): Promise<BrokerResponse> {
    switch (body.method) {
      case "START_RUN":
        return this.startRun(body.requestId, body.params.originalRequest);
      case "ENSURE_WORKSPACE":
        return {
          requestId: body.requestId,
          outcome: "WORKSPACE",
          workspace: {
            schemaVersion: 1,
            workspaceId: this.world.workspaceId,
            projectId: this.world.projectId,
            alias: this.world.workspaceId,
            status: "READY",
          },
        };
      case "GET_RUN_STATUS":
      case "RESUME_RUN":
        return this.getRun(body.requestId, body.params.runId);
      case "LIST_AGENTS":
        return this.listAgents(body.requestId, body.params.runId);
      case "POLL_RUN_EVENTS":
        return this.pollEvents(
          body.requestId,
          body.params.runId,
          body.params.afterSequence,
          body.params.limit,
        );
      case "PROVIDE_INPUT":
        return this.provideInput(body);
      case "REQUEST_REPAIR":
        return this.mutateRun(
          body.requestId,
          "requestRunRepair",
          body.params.runId,
          body.params.expectedStateVersion,
          {
            schemaVersion: 1,
            verdictReportObjectDigest: body.params.verdictReportObjectDigest,
          },
        );
      case "CANCEL_RUN":
        return this.mutateRun(
          body.requestId,
          "cancelRun",
          body.params.runId,
          body.params.expectedStateVersion,
          {
            schemaVersion: 1,
            reason: body.params.reason,
          },
        );
      case "OPEN_TRUSTED_VIEW":
      case "OPEN_APPROVAL":
        return {
          requestId: body.requestId,
          outcome: "TRUSTED_UI_OPENED",
          trustedUiSessionId: "tui_golden_eval",
          nonce: "nonce-trusted-ui",
        };
      default: {
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  }

  close(): void {
    return;
  }

  private async startRun(requestId: string, originalRequest: string): Promise<BrokerResponse> {
    const runId = asRunId(randomPrefixedUuidV7("run_"));
    const createdAt = this.world.clock();
    const response = await this.world.broker.call({
      operationId: "createRun",
      pathParams: { projectId: this.world.projectId, runId },
      body: jsonBody({
        schemaVersion: 1,
        workspaceId: this.world.workspaceId,
        task: {
          schemaVersion: 1,
          runId,
          originalRequest,
          originalRequestDigest: sha256Utf8(originalRequest),
          userScope: {
            allowedPathGlobs: [],
            forbiddenPathGlobs: [],
            forbiddenOperations: [],
          },
          attachments: [],
          requestedVerificationCommands: [],
          createdAt,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    return this.runOutcome(requestId, response.status, response.body);
  }

  private async getRun(requestId: string, runId: RunId): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "getRun",
      pathParams: { projectId: this.world.projectId, runId },
    });
    return this.runOutcome(requestId, response.status, response.body);
  }

  private async listAgents(requestId: string, runId: RunId): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "listRunAgents",
      pathParams: { projectId: this.world.projectId, runId },
    });
    if (response.status >= 400) {
      const error = httpError(requestId, response.body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(response.body);
    if (!AGENTS.Check(parsed)) {
      return internalError(requestId, "RunAgentsPage failed schema");
    }
    this.lastAgents = parsed;
    return { requestId, outcome: "AGENTS", agents: parsed };
  }

  private async pollEvents(
    requestId: string,
    runId: RunId,
    afterSequence: number,
    limit: number,
  ): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "listRunEvents",
      pathParams: { projectId: this.world.projectId, runId },
      query: { after: afterSequence, limit },
    });
    if (response.status >= 400) {
      return httpError(requestId, response.body);
    }
    const parsed: unknown = parseJson(response.body);
    if (!EVENTS.Check(parsed)) {
      return {
        requestId,
        outcome: "EVENTS",
        page: { schemaVersion: 1, events: [], nextAfter: null },
      };
    }
    return { requestId, outcome: "EVENTS", page: parsed };
  }

  private async provideInput(
    body: Extract<BrokerRequest, { method: "PROVIDE_INPUT" }>,
  ): Promise<BrokerResponse> {
    return this.mutateRun(
      body.requestId,
      "provideRunInput",
      body.params.runId,
      body.params.expectedStateVersion,
      {
        schemaVersion: 1,
        questionId: body.params.questionId,
        answer: body.params.answer,
        source: "user",
      },
    );
  }

  private async mutateRun(
    requestId: string,
    operationId: "provideRunInput" | "requestRunRepair" | "cancelRun",
    runId: RunId,
    expectedStateVersion: number,
    payload: unknown,
  ): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId,
      pathParams: { projectId: this.world.projectId, runId },
      body: jsonBody(payload),
      headers: {
        "content-type": "application/json",
        "if-match": `"${String(expectedStateVersion)}"`,
      },
    });
    if (response.status >= 400) {
      const error = httpError(requestId, response.body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(response.body);
    if (!OPERATION.Check(parsed)) {
      return internalError(requestId, "OperationProjection failed schema");
    }
    this.lastOperation = parsed;
    return { requestId, outcome: "OPERATION_ACCEPTED", operation: parsed };
  }

  private runOutcome(requestId: string, status: number, body: Buffer): BrokerResponse {
    if (status >= 400) {
      const error = httpError(requestId, body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(body);
    if (!RUN.Check(parsed)) {
      return internalError(requestId, "RunProjection failed schema");
    }
    this.lastRun = parsed;
    return { requestId, outcome: "RUN", run: parsed };
  }
}

export function pointerRunId(entries: readonly { customType?: string; data?: unknown }[]): RunId {
  const entry = [...entries].reverse().find((item) => item.customType === "hec-run-pointer");
  const data = entry?.data;
  if (data === null || typeof data !== "object" || !("activeRunId" in data)) {
    throw new Error("active run missing");
  }
  const runId = Reflect.get(data, "activeRunId");
  if (typeof runId !== "string") {
    throw new Error("active run id missing");
  }
  return asRunId(runId);
}
