import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import { SourceRangeSchema } from "../src/schemas/artifacts.js";
import { RequirementLedgerSchema, RunTransitionEventSchema } from "../src/schemas/run.js";
import { OPERATION_KINDS } from "../src/generated/run-states.js";
import { RUN_EVENT_TYPES } from "../src/generated/run-event-registry.js";
import {
  CanonicalCloudRequestSchema,
  RequestContextToolParametersSchema,
  SubmitSolutionToolParametersSchema,
} from "../src/schemas/cloud.js";
import { ApprovalSubjectSchema } from "../src/schemas/secrets.js";
import { HTTP_OPERATIONS } from "../src/schemas/http-operations.js";
import {
  HttpArtifactsQuerySchema,
  HttpEventsQuerySchema,
  OperationProjectionSchema,
} from "../src/schemas/http.js";
import { generateOpenApiDocument } from "../src/openapi.js";
import {
  CALL,
  DIGEST,
  PROJ,
  RUN,
  SNAP,
  TS,
  acceptAndRejectExtra,
  cloudResultBinding,
  initialRequestBinding,
} from "./helpers.js";

test("RequirementLedger.nonGoals rejects deterministic-check requirements", () => {
  const validator = Compile(RequirementLedgerSchema);
  const authoritative = {
    id: "req_" + "a".repeat(52),
    text: "must compile",
    sourceRefs: [],
    priority: "MUST",
    state: "CLEAR",
    kind: "authoritative",
    source: "USER_EXPLICIT",
    normative: true,
  };
  const check = {
    ...authoritative,
    kind: "deterministic-check",
    source: "EXISTING_TEST",
    normative: false,
  };
  expect(
    validator.Check({
      schemaVersion: 1,
      runId: RUN,
      originalRequest: "build it",
      originalRequestDigest: DIGEST,
      requirements: [authoritative],
      nonGoals: [authoritative],
      conflicts: [],
      openQuestions: [],
    }),
  ).toBe(true);
  expect(
    validator.Check({
      schemaVersion: 1,
      runId: RUN,
      originalRequest: "build it",
      originalRequestDigest: DIGEST,
      requirements: [authoritative],
      nonGoals: [check],
      conflicts: [],
      openQuestions: [],
    }),
  ).toBe(false);
});

test("RunTransitionEvent.eventType is the closed RunEventType union", () => {
  const validator = Compile(RunTransitionEventSchema);
  const base = {
    schemaVersion: 1,
    eventId: "evt-1",
    eventType: "ENTER_SNAPSHOT_READY",
    projectId: PROJ,
    runId: RUN,
    sequence: 1,
    previousState: "SNAPSHOT_VALIDATING",
    nextState: "SNAPSHOT_READY",
    actorType: "control",
    actorId: "control-1",
    inputArtifactObjectDigests: [],
    outputArtifactObjectDigests: [],
    reasonCode: "advance",
    occurredAt: TS,
  };
  expect(validator.Check(base)).toBe(true);
  expect(validator.Check({ ...base, eventType: "NOT_A_REAL_EVENT" })).toBe(false);
  expect(validator.Check({ ...base, eventType: "enter_snapshot_ready" })).toBe(false);
  expect(RUN_EVENT_TYPES.includes("ENTER_SNAPSHOT_READY")).toBe(true);
});

test("OperationProjection.kind is OperationKind enum", () => {
  const validator = Compile(OperationProjectionSchema);
  const base = {
    schemaVersion: 1,
    projectId: PROJ,
    operationId: "op_01234567-89ab-7cde-8f01-23456789abcd",
    runId: RUN,
    kind: "CAPTURE_SNAPSHOT",
    state: "ready",
    leaseGeneration: 1,
    updatedAt: TS,
  };
  expect(validator.Check(base)).toBe(true);
  expect(validator.Check({ ...base, kind: "not-an-operation" })).toBe(false);
  expect(validator.Check({ ...base, kind: "capture_snapshot" })).toBe(false);
  expect(OPERATION_KINDS).toHaveLength(23);
});

test("ApprovalSubject.cloudCallId uses UUID v7 CloudCallId", () => {
  const validator = Compile(ApprovalSubjectSchema);
  const valid = {
    schemaVersion: 1,
    kind: "cloud-egress",
    runId: RUN,
    cloudCallId: CALL,
    baseSnapshotRootDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    compiledConversationObjectDigest: DIGEST,
    egressManifestObjectDigest: DIGEST,
    canonicalCloudRequestObjectDigest: DIGEST,
    providerWireRequestObjectDigest: DIGEST,
    deploymentId: PROJ,
    adapterVersionObjectDigest: DIGEST,
    endpointIdentity: "https://provider.test",
    modelRevision: "m1",
    retentionPolicyObjectDigest: DIGEST,
  };
  expect(validator.Check(valid)).toBe(true);
  expect(validator.Check({ ...valid, cloudCallId: "call_not-a-uuid" })).toBe(false);
  expect(validator.Check({ ...valid, extra: true })).toBe(false);
});

test("tool parameter schemas omit schemaVersion", () => {
  const submit = Compile(SubmitSolutionToolParametersSchema);
  const context = Compile(RequestContextToolParametersSchema);
  const solution = {
    kind: "submit_solution",
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    baseSnapshotId: SNAP,
    baseSnapshotRootDigest: DIGEST,
    summary: "no edits",
    assumptions: [],
    unresolvedFacts: [],
    disposition: "no_change",
    noChangeEvidenceIds: ["evidence_" + "a".repeat(52)],
    requirementTrace: [
      { requirementId: "req_" + "a".repeat(52), evidenceIds: ["evidence_" + "a".repeat(52)] },
    ],
  };
  const requestContext = {
    kind: "request_context",
    runId: RUN,
    cloudCallId: CALL,
    requestBindingDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    baseSnapshotId: SNAP,
    baseSnapshotRootDigest: DIGEST,
    missingClaimIds: ["evidence_" + "a".repeat(52)],
    requestedEvidenceKinds: [],
    pathOrSymbolHints: [],
    requestedSkillIds: [],
    reason: "need graph",
  };
  expect(submit.Check(solution)).toBe(true);
  expect(submit.Check({ ...solution, schemaVersion: 1 })).toBe(false);
  expect(context.Check(requestContext)).toBe(true);
  expect(context.Check({ ...requestContext, schemaVersion: 1 })).toBe(false);
  expect(submit.Check({ ...cloudResultBinding, ...solution })).toBe(false);
});

test("CanonicalCloudRequest purpose is pinned to requestBinding.purpose", () => {
  const validator = Compile(CanonicalCloudRequestSchema);
  const initial = {
    schemaVersion: 1,
    purpose: "initial",
    runId: RUN,
    cloudCallId: CALL,
    requestBinding: initialRequestBinding,
    requestBindingDigest: DIGEST,
    deploymentId: PROJ,
    adapterVersionObjectDigest: DIGEST,
    contextPacketObjectDigest: DIGEST,
    egressManifestObjectDigest: DIGEST,
    compiledConversationObjectDigest: DIGEST,
    resultMode: "terminal-tools",
    maxOutputTokens: 1024,
    reasoningProfile: "default",
  };
  expect(validator.Check(initial)).toBe(true);
  expect(
    validator.Check({
      ...initial,
      requestBinding: { ...initialRequestBinding, purpose: "repair", parentCloudCallId: CALL },
    }),
  ).toBe(false);
  expect(validator.Check({ ...initial, extra: true })).toBe(false);
  expect(validator.Check({ ...initial, runId: "run_01234567-89ab-7cde-8f01-23456789abce" })).toBe(
    false,
  );
});

test("SourceRange bytes enforces 0 <= start < end in Compile().Check", () => {
  const validator = Compile(SourceRangeSchema);
  expect(validator.Check({ kind: "whole" })).toBe(true);
  expect(validator.Check({ kind: "bytes", byteStart: 0, byteEnd: 4 })).toBe(true);
  expect(validator.Check({ kind: "bytes", byteStart: 4, byteEnd: 4 })).toBe(false);
  expect(validator.Check({ kind: "bytes", byteStart: 5, byteEnd: 3 })).toBe(false);
  expect(validator.Check({ kind: "bytes", byteStart: 0, byteEnd: 0 })).toBe(false);
});

test("HTTP event after is uint sequence and artifact after is cursor string", () => {
  const events = Compile(HttpEventsQuerySchema);
  const artifacts = Compile(HttpArtifactsQuerySchema);
  expect(events.Check({ after: 12, limit: 20 })).toBe(true);
  expect(events.Check({ after: "cursor", limit: 20 })).toBe(false);
  expect(artifacts.Check({ after: "cursor-1", limit: 20 })).toBe(true);
  expect(artifacts.Check({ after: 12, limit: 20 })).toBe(false);
});

test("OpenAPI components.schemas are full JSON Schema 2020-12 and query params exist", () => {
  const document = generateOpenApiDocument();
  expect(document.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
  const required = [
    "ApiError",
    "CreateProjectResponse",
    "CreateProjectRequest",
    "RunEventPage",
    "RunArtifactPage",
    "OperationProjection",
    "ProjectProjection",
    "RunProjection",
  ];
  for (const name of required) {
    const schema = document.components.schemas[name];
    if (schema === undefined) {
      throw new Error(`OpenAPI document is missing component schema ${name}`);
    }
    expect(schema).not.toEqual({ type: "object" });
    expect(schema).not.toEqual({ type: "object", additionalProperties: false });
    expect(
      schema.properties !== undefined ||
        schema.anyOf !== undefined ||
        schema.oneOf !== undefined ||
        schema.$ref !== undefined,
    ).toBe(true);
  }
  const apiError = document.components.schemas.ApiError ?? {};
  const apiErrorProperties =
    apiError.properties !== null && typeof apiError.properties === "object"
      ? apiError.properties
      : {};
  expect("schemaVersion" in apiErrorProperties).toBe(true);
  expect("code" in apiErrorProperties).toBe(true);
  expect("message" in apiErrorProperties).toBe(true);
  const events = document.paths["/v1/projects/{projectId}/runs/{runId}/events"]?.get;
  const artifacts = document.paths["/v1/projects/{projectId}/runs/{runId}/artifacts"]?.get;
  const eventAfter = events?.parameters.find(
    (parameter) => parameter.name === "after" && parameter.in === "query",
  );
  const artifactAfter = artifacts?.parameters.find(
    (parameter) => parameter.name === "after" && parameter.in === "query",
  );
  const eventLimit = events?.parameters.find(
    (parameter) => parameter.name === "limit" && parameter.in === "query",
  );
  expect(eventAfter?.schema).toMatchObject({ type: "integer" });
  expect(artifactAfter?.schema).toMatchObject({ type: "string" });
  expect(eventLimit).toBeDefined();
  for (const operation of HTTP_OPERATIONS) {
    for (const success of operation.success) {
      if (success.schemaName === null) {
        continue;
      }
      const ref = `#/components/schemas/${success.schemaName}`;
      expect(document.components.schemas[success.schemaName]).toBeDefined();
      const response =
        document.paths[operation.path]?.[operation.method.toLowerCase()]?.responses[
          String(success.status)
        ];
      const jsonSchema =
        response !== undefined && response.content !== undefined
          ? (response.content as { "application/json"?: { schema?: unknown } })["application/json"]
              ?.schema
          : undefined;
      expect(jsonSchema).toEqual({ $ref: ref });
    }
    if (operation.requestSchemaName !== null && operation.method !== "GET") {
      expect(document.components.schemas[operation.requestSchemaName]).toBeDefined();
    }
  }
  expect(document.components.schemas.ApiError).toBeDefined();
});

test("OpenAPI 3.1 component schema keys match OAS key grammar", () => {
  const document = generateOpenApiDocument();
  const oasComponentKey = /^[a-zA-Z0-9.\-_]+$/;
  for (const key of Object.keys(document.components.schemas)) {
    expect(key, key).toMatch(oasComponentKey);
  }
  const serialized = JSON.stringify(document);
  for (const match of serialized.matchAll(/#\/components\/schemas\/([^"]+)/g)) {
    const key = match[1];
    expect(key, key).toBeDefined();
    if (key === undefined) {
      continue;
    }
    expect(key).toMatch(oasComponentKey);
    expect(document.components.schemas[key]).toBeDefined();
  }
  expect(document.components.schemas.ArtifactEnvelopeApprovalChallenge).toBeDefined();
  expect(document.components.schemas["ArtifactEnvelope<ApprovalChallenge>"]).toBeUndefined();
});

test("closed objects still reject extra properties", () => {
  acceptAndRejectExtra(HttpEventsQuerySchema, { after: 1, limit: 10 });
});
