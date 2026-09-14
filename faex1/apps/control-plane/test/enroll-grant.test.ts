import { afterAll, beforeAll, expect, test } from "vitest";
import { jsonBody } from "@pi-hec/client";
import {
  PROJECT_ID,
  RUNNER_ID,
  approvalId,
  createProjectBody,
  parseJson,
  startHarness,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return harness;
}

test("broker enrollProject creates an untrusted project while createProject stays admin-only", async () => {
  const current = requireHarness();
  const projectId = "enroll.alpha";
  const enrolled = await current.broker.call({
    operationId: "enrollProject",
    headers: { "content-type": "application/json" },
    body: jsonBody(createProjectBody(projectId)),
  });
  expect(enrolled.status).toBe(201);
  const body = parseJson(enrolled.body) as { project: { projectId: string; trustState: string } };
  expect(body.project.projectId).toBe(projectId);
  expect(body.project.trustState).toBe("untrusted");
});

test("grantRunnerProject after enroll and trust is 201 then idempotent 200", async () => {
  const current = requireHarness();
  const projectId = "enroll.grant.beta";
  const enrolled = await current.broker.call({
    operationId: "enrollProject",
    headers: { "content-type": "application/json" },
    body: jsonBody(createProjectBody(projectId)),
  });
  expect(enrolled.status).toBe(201);
  const enrollEtag = enrolled.headers.etag;
  if (enrollEtag === undefined) {
    throw new Error("enroll etag missing");
  }
  const refused = await current.broker.call({
    operationId: "grantRunnerProject",
    pathParams: { projectId },
    headers: { "content-type": "application/json", "if-match": enrollEtag },
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      approvalId: approvalId(43),
    }),
  });
  expect(refused.status).toBe(404);
  const trusted = await current.broker.call({
    operationId: "setProjectTrust",
    pathParams: { projectId },
    headers: { "content-type": "application/json", "if-match": enrollEtag },
    body: jsonBody({
      schemaVersion: 1,
      trustState: "trusted",
      approvalId: approvalId(44),
    }),
  });
  expect(trusted.status).toBe(200);
  const trustEtag = trusted.headers.etag;
  if (trustEtag === undefined) {
    throw new Error("trust etag missing");
  }
  const first = await current.broker.call({
    operationId: "grantRunnerProject",
    pathParams: { projectId },
    headers: { "content-type": "application/json", "if-match": trustEtag },
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      approvalId: approvalId(45),
    }),
  });
  expect(first.status).toBe(201);
  const granted = parseJson(first.body) as { granted: boolean; projectId: string };
  expect(granted.granted).toBe(true);
  expect(granted.projectId).toBe(projectId);
  const second = await current.broker.call({
    operationId: "grantRunnerProject",
    pathParams: { projectId },
    headers: { "content-type": "application/json", "if-match": trustEtag },
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      approvalId: approvalId(46),
    }),
  });
  expect(second.status).toBe(200);
});

test("grantRunnerProject is idempotent for an already granted runner", async () => {
  const current = requireHarness();
  const listed = await current.broker.call({
    operationId: "getProject",
    pathParams: { projectId: PROJECT_ID },
  });
  expect(listed.status).toBe(200);
  const etag = listed.headers.etag;
  if (etag === undefined) {
    throw new Error("project etag missing");
  }
  const first = await current.broker.call({
    operationId: "grantRunnerProject",
    pathParams: { projectId: PROJECT_ID },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      approvalId: approvalId(41),
    }),
  });
  expect(first.status).toBe(200);
  const granted = parseJson(first.body) as { granted: boolean; runnerId: string };
  expect(granted.granted).toBe(true);
  expect(granted.runnerId).toBe(RUNNER_ID);
  const second = await current.broker.call({
    operationId: "grantRunnerProject",
    pathParams: { projectId: PROJECT_ID },
    headers: { "content-type": "application/json", "if-match": etag },
    body: jsonBody({
      schemaVersion: 1,
      runnerId: RUNNER_ID,
      approvalId: approvalId(42),
    }),
  });
  expect(second.status).toBe(200);
});
