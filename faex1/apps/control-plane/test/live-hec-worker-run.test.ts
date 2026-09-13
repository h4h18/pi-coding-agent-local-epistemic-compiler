import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { ControlPlaneClient, jsonBody } from "@pi-hec/client";
import { asRunId, randomPrefixedUuidV7, sha256Utf8 } from "@pi-hec/contracts";
import { createMutationSigner } from "../src/host-runtime.js";
import { parseJson } from "./harness.js";

const live = process.env.PI_HEC_LIVE_STACK === "1";
const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT ?? "https://10.10.10.184:8443";
const enrollEndpoint = process.env.PI_HEC_ENROLL_ENDPOINT ?? "https://10.10.10.184:8444";
const pkiDir = process.env.PI_HEC_CLIENT_PKI ?? path.join(os.homedir(), ".pi-hec", "pki");
const projectId = process.env.PI_HEC_PROJECT_ID ?? "live.hec.task";
const workspaceId = process.env.PI_HEC_WORKSPACE_ID ?? "pi-hec-prod-e2e";

function pem(name: string): Buffer {
  return readFileSync(path.join(pkiDir, name));
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label);
  }
  return value as Record<string, unknown>;
}

const required = [
  "ca.crt.pem",
  "broker.crt.pem",
  "broker.key.pem",
  "broker.sign.key.pem",
];
const ready = live && required.every((name) => existsSync(path.join(pkiDir, name)));
const clients: ControlPlaneClient[] = [];

afterAll(() => {
  for (const client of clients) {
    client.close();
  }
});

test.skipIf(!ready)("broker createRun enqueues a FAST worker path on FA-EX1", async () => {
  const host = new URL(endpoint).hostname;
  const broker = new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ca: pem("ca.crt.pem"),
      cert: pem("broker.crt.pem"),
      key: pem("broker.key.pem"),
      servername: host,
    },
    enrollTls: {
      ca: pem("ca.crt.pem"),
      servername: host,
    },
    signer: createMutationSigner(createPrivateKey(pem("broker.sign.key.pem")), "broker-1"),
  });
  clients.push(broker);
  const runId = asRunId(randomPrefixedUuidV7("run_"));
  const originalRequest = "добавь локальную форму логина, не трогая secrets";
  const createdAt = new Date().toISOString();
  const created = await broker.call({
    operationId: "createRun",
    pathParams: { projectId, runId },
    body: jsonBody({
      schemaVersion: 1,
      workspaceId,
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
  expect(created.status, created.body.toString("utf8")).toBe(201);
  const run = asObject(parseJson(created.body), "createRun");
  expect(Reflect.get(run, "runId")).toBe(runId);
  const got = await broker.call({
    operationId: "getRun",
    pathParams: { projectId, runId },
  });
  expect(got.status).toBe(200);
  const listed = await broker.call({
    operationId: "listRunAgents",
    pathParams: { projectId, runId },
  });
  expect(listed.status).toBe(200);
  process.stdout.write(`FAEX1_LIVE_RUN=${runId}\n`);
});
