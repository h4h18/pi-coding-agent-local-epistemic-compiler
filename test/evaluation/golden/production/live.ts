import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlPlaneClient } from "@pi-hec/client";
import { sha256Utf8 } from "@pi-hec/contracts";
import {
  FAEX1_HOST_CAPABILITY_PREIMAGE,
  createMutationSigner,
} from "../../../../faex1/apps/control-plane/src/host-runtime.js";
import { FAEX1_HOST_RUNNER_ID } from "../../../../faex1/apps/control-plane/src/host-snapshot-runner.js";
import type { ControlPlaneBrokerWorld } from "./control-broker.js";

export type OpenedLiveGoldenWorld = {
  world: ControlPlaneBrokerWorld;
  client: ControlPlaneClient;
  runner: ControlPlaneClient;
  runnerId: string;
  capabilitiesObjectDigest: string;
};

function pkiDir(): string {
  return process.env.PI_HEC_CLIENT_PKI ?? path.join(os.homedir(), ".pi-hec", "pki");
}

export function liveGoldenStackReady(): boolean {
  if (process.env.PI_HEC_LIVE_STACK !== "1") {
    return false;
  }
  const dir = pkiDir();
  return [
    "ca.crt.pem",
    "broker.crt.pem",
    "broker.key.pem",
    "broker.sign.key.pem",
    "runner.crt.pem",
    "runner.key.pem",
    "runner.sign.key.pem",
  ].every((name) => existsSync(path.join(dir, name)));
}

export function openLiveGoldenWorld(): OpenedLiveGoldenWorld {
  const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT ?? "https://10.10.10.184:8443";
  const enrollEndpoint = process.env.PI_HEC_ENROLL_ENDPOINT ?? "https://10.10.10.184:8444";
  const dir = pkiDir();
  const pem = (name: string): Buffer => readFileSync(path.join(dir, name));
  const host = new URL(endpoint).hostname;
  const tls = {
    ca: pem("ca.crt.pem"),
    servername: host,
  };
  const client = new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ...tls,
      cert: pem("broker.crt.pem"),
      key: pem("broker.key.pem"),
    },
    enrollTls: tls,
    signer: createMutationSigner(createPrivateKey(pem("broker.sign.key.pem")), "broker-1"),
  });
  const runner = new ControlPlaneClient({
    baseUrl: endpoint,
    enrollBaseUrl: enrollEndpoint,
    tls: {
      ...tls,
      cert: pem("runner.crt.pem"),
      key: pem("runner.key.pem"),
    },
    enrollTls: tls,
    signer: createMutationSigner(createPrivateKey(pem("runner.sign.key.pem")), "runner-principal"),
  });
  return {
    client,
    runner,
    runnerId: process.env.PI_HEC_HOST_RUNNER_ID ?? FAEX1_HOST_RUNNER_ID,
    capabilitiesObjectDigest: sha256Utf8(FAEX1_HOST_CAPABILITY_PREIMAGE),
    world: {
      clock: () => new Date().toISOString(),
      broker: client,
      projectId: process.env.PI_HEC_PROJECT_ID ?? "live.hec.task",
      workspaceId: process.env.PI_HEC_WORKSPACE_ID ?? "pi-hec-prod-e2e",
    },
  };
}
