import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { ControlPlaneClient, jsonBody } from "@pi-hec/client";
import { createMutationSigner } from "../src/host-runtime.js";
import { createProjectBody, parseJson } from "./harness.js";

const live = process.env.PI_HEC_LIVE_STACK === "1";
const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT ?? "https://10.10.10.184:8443";
const enrollEndpoint = process.env.PI_HEC_ENROLL_ENDPOINT ?? "https://10.10.10.184:8444";
const pkiDir = process.env.PI_HEC_CLIENT_PKI ?? path.join(os.homedir(), ".pi-hec", "pki");

function pem(name: string): Buffer {
  return readFileSync(path.join(pkiDir, name));
}

function liveClient(kind: "admin" | "broker" | "worker"): ControlPlaneClient {
  const host = new URL(endpoint).hostname;
  return new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ca: pem("ca.crt.pem"),
      cert: pem(`${kind}.crt.pem`),
      key: pem(`${kind}.key.pem`),
      servername: host,
    },
    enrollTls: {
      ca: pem("ca.crt.pem"),
      servername: host,
    },
    signer: createMutationSigner(createPrivateKey(pem(`${kind}.sign.key.pem`)), `${kind}-1`),
  });
}

const required = [
  "ca.crt.pem",
  "admin.crt.pem",
  "admin.key.pem",
  "admin.sign.key.pem",
  "broker.crt.pem",
  "broker.key.pem",
  "broker.sign.key.pem",
];
const workerRequired = ["worker.crt.pem", "worker.key.pem", "worker.sign.key.pem"];
const ready = live && required.every((name) => existsSync(path.join(pkiDir, name)));
const workerReady = ready && workerRequired.every((name) => existsSync(path.join(pkiDir, name)));

const clients: ControlPlaneClient[] = [];

afterAll(() => {
  for (const client of clients) {
    client.close();
  }
});

test.skipIf(!ready)("Windows admin and broker clients reach FAEX1 control plane", async () => {
  const admin = liveClient("admin");
  const broker = liveClient("broker");
  clients.push(admin, broker);
  const projectId = `live.${Date.now().toString(10)}`;
  const created = await admin.call({
    operationId: "createProject",
    body: jsonBody(createProjectBody(projectId)),
    headers: { "content-type": "application/json" },
  });
  expect(created.status).toBe(201);
  const createdBody = parseJson(created.body);
  if (createdBody === null || typeof createdBody !== "object" || Array.isArray(createdBody)) {
    throw new Error("createProject body");
  }
  const project = Reflect.get(createdBody, "project");
  if (project === null || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("createProject project");
  }
  expect(Reflect.get(project, "projectId")).toBe(projectId);
  const gotAdmin = await admin.call({
    operationId: "getProject",
    pathParams: { projectId },
  });
  expect(gotAdmin.status).toBe(200);
  const gotBroker = await broker.call({
    operationId: "getProject",
    pathParams: { projectId },
  });
  expect(gotBroker.status).toBe(200);
  const brokerBody = parseJson(gotBroker.body);
  if (brokerBody === null || typeof brokerBody !== "object" || Array.isArray(brokerBody)) {
    throw new Error("broker getProject body");
  }
  expect(Reflect.get(brokerBody, "projectId")).toBe(projectId);
});

test.skipIf(!workerReady)("FAEX1 worker identity leases idle NO_JOB from Windows", async () => {
  const worker = liveClient("worker");
  clients.push(worker);
  const leased = await worker.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: "faex1-worker",
      capabilitiesObjectDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json" },
  });
  expect(leased.status).toBe(200);
  const leaseBody = parseJson(leased.body);
  if (leaseBody === null || typeof leaseBody !== "object" || Array.isArray(leaseBody)) {
    throw new Error("worker lease body");
  }
  expect(Reflect.get(leaseBody, "outcome")).toBe("NO_JOB");
});
