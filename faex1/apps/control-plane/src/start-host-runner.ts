import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneClient } from "@pi-hec/client";
import { sha256Utf8 } from "@pi-hec/contracts";
import {
  DEFAULT_ETC_DIR,
  FAEX1_HOST_CAPABILITY_PREIMAGE,
  createMutationSigner,
  type HostIdentitiesFile,
} from "./host-runtime.js";
import {
  FAEX1_HOST_RUNNER_ID,
  executeLeasedCaptureJob,
  leaseHostRunnerJob,
} from "./host-snapshot-runner.js";

function interruptibleSleep(ms: number, isStopping: () => boolean, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    if (isStopping()) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function workspaceRootByIdFromEnv(): Readonly<Record<string, string>> {
  const workspaceId = process.env.PI_HEC_WORKSPACE_ID;
  const workspaceRoot = process.env.PI_HEC_WORKSPACE_ROOT;
  if (workspaceId === undefined || workspaceId.length === 0) {
    throw new Error("PI_HEC_WORKSPACE_ID is required");
  }
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    throw new Error("PI_HEC_WORKSPACE_ROOT is required");
  }
  return { [workspaceId]: workspaceRoot };
}

function openHostRunnerClient(): {
  client: ControlPlaneClient;
  runnerId: string;
  capabilitiesObjectDigest: string;
} {
  const clientPki = process.env.PI_HEC_CLIENT_PKI;
  if (clientPki !== undefined) {
    const endpoint = process.env.PI_HEC_CONTROL_ENDPOINT;
    const enrollEndpoint = process.env.PI_HEC_ENROLL_ENDPOINT;
    if (endpoint === undefined || enrollEndpoint === undefined) {
      throw new Error("PI_HEC_CONTROL_ENDPOINT and PI_HEC_ENROLL_ENDPOINT are required with PI_HEC_CLIENT_PKI");
    }
    const host = new URL(endpoint).hostname;
    const pem = (name: string): Buffer => readFileSync(path.join(clientPki, name));
    return {
      runnerId: process.env.PI_HEC_RUNNER_ID ?? FAEX1_HOST_RUNNER_ID,
      capabilitiesObjectDigest: sha256Utf8(FAEX1_HOST_CAPABILITY_PREIMAGE),
      client: new ControlPlaneClient({
        baseUrl: endpoint,
        enrollBaseUrl: enrollEndpoint,
        tls: {
          ca: pem("ca.crt.pem"),
          cert: pem("runner.crt.pem"),
          key: pem("runner.key.pem"),
          servername: host,
        },
        enrollTls: {
          ca: pem("ca.crt.pem"),
          servername: host,
        },
        signer: createMutationSigner(createPrivateKey(pem("runner.sign.key.pem")), "runner-principal"),
      }),
    };
  }
  const etcDir = process.env.PI_HEC_ETC ?? DEFAULT_ETC_DIR;
  const identities = JSON.parse(
    readFileSync(path.join(etcDir, "identities.json"), "utf8"),
  ) as HostIdentitiesFile;
  const baseUrl = `https://${identities.listenHost}:${String(identities.mtlsPort)}`;
  const enrollBaseUrl = `https://${identities.listenHost}:${String(identities.enrollPort)}`;
  const signKey = createPrivateKey(readFileSync(path.join(etcDir, "pki", "runner.sign.key.pem"), "utf8"));
  return {
    runnerId: process.env.PI_HEC_RUNNER_ID ?? FAEX1_HOST_RUNNER_ID,
    capabilitiesObjectDigest: identities.capabilityDigest,
    client: new ControlPlaneClient({
      baseUrl,
      enrollBaseUrl,
      tls: {
        ca: readFileSync(path.join(etcDir, "pki", "ca.crt.pem")),
        cert: readFileSync(path.join(etcDir, "pki", "runner.crt.pem")),
        key: readFileSync(path.join(etcDir, "pki", "runner.key.pem")),
        servername: identities.listenHost,
      },
      enrollTls: {
        ca: readFileSync(path.join(etcDir, "pki", "ca.crt.pem")),
        servername: identities.listenHost,
      },
      signer: createMutationSigner(signKey, "runner-principal"),
    }),
  };
}

async function startHostRunner(): Promise<void> {
  const opened = openHostRunnerClient();
  const workspaceRootById = workspaceRootByIdFromEnv();
  let stopping = false;
  let wakeSleep: (() => void) | undefined;
  const shutdown = (): void => {
    stopping = true;
    wakeSleep?.();
    opened.client.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  for (;;) {
    if (stopping) {
      return;
    }
    try {
      const leased = await leaseHostRunnerJob({
        client: opened.client,
        runnerId: opened.runnerId,
        capabilitiesObjectDigest: opened.capabilitiesObjectDigest,
      });
      if (stopping) {
        return;
      }
      if (leased.outcome !== "LEASED") {
        await interruptibleSleep(leased.retryAfterMs, () => stopping, (wake) => {
          wakeSleep = wake;
        });
        continue;
      }
      await executeLeasedCaptureJob({
        client: opened.client,
        job: leased.job,
        workspaceRootById,
        runnerId: opened.runnerId,
        now: () => new Date().toISOString(),
      });
    } catch (error) {
      if (stopping) {
        return;
      }
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
      await interruptibleSleep(5000, () => stopping, (wake) => {
        wakeSleep = wake;
      });
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void startHostRunner();
}
