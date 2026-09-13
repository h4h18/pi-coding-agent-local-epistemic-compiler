import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneClient } from "@pi-hec/client";
import { DEFAULT_ETC_DIR, createMutationSigner, type HostIdentitiesFile } from "./host-runtime.js";
import {
  FAEX1_WORKER_RUNNER_ID,
  createFaex1AgentRuntime,
  executeLeasedAgentJob,
  leaseWorkerJob,
} from "./worker-agent.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startWorker(): Promise<void> {
  const etcDir = process.env.PI_HEC_ETC ?? DEFAULT_ETC_DIR;
  const identities = JSON.parse(
    readFileSync(path.join(etcDir, "identities.json"), "utf8"),
  ) as HostIdentitiesFile;
  const baseUrl = `https://${identities.listenHost}:${String(identities.mtlsPort)}`;
  const enrollBaseUrl = `https://${identities.listenHost}:${String(identities.enrollPort)}`;
  const signKey = createPrivateKey(
    readFileSync(path.join(etcDir, "pki", "worker.sign.key.pem"), "utf8"),
  );
  const client = new ControlPlaneClient({
    baseUrl,
    enrollBaseUrl,
    tls: {
      ca: readFileSync(path.join(etcDir, "pki", "ca.crt.pem")),
      cert: readFileSync(path.join(etcDir, "pki", "worker.crt.pem")),
      key: readFileSync(path.join(etcDir, "pki", "worker.key.pem")),
      servername: identities.listenHost,
    },
    enrollTls: {
      ca: readFileSync(path.join(etcDir, "pki", "ca.crt.pem")),
      servername: identities.listenHost,
    },
    signer: createMutationSigner(signKey, "worker-1"),
  });
  const runtime = createFaex1AgentRuntime(() => new Date().toISOString());
  let stopping = false;
  const shutdown = (): void => {
    stopping = true;
    client.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  for (;;) {
    if (stopping) {
      return;
    }
    try {
      const leased = await leaseWorkerJob({
        client,
        runnerId: FAEX1_WORKER_RUNNER_ID,
        capabilitiesObjectDigest: identities.capabilityDigest,
      });
      if (stopping) {
        return;
      }
      if (leased.outcome !== "LEASED") {
        await sleep(leased.retryAfterMs);
        continue;
      }
      await executeLeasedAgentJob({
        client,
        job: leased.job,
        runtime,
      });
    } catch (error) {
      if (stopping) {
        return;
      }
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
      await sleep(5000);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void startWorker();
}
