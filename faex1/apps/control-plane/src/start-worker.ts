import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ControlPlaneClient, jsonBody } from "@pi-hec/client";
import {
  DEFAULT_ETC_DIR,
  createMutationSigner,
  type HostIdentitiesFile,
} from "./host-runtime.js";

const WORKER_KINDS = new Set([
  "RESOLVE_INSTRUCTIONS",
  "INDEX_SNAPSHOT",
  "PLAN_BASELINE",
  "RUN_BASELINE_CHECK",
  "RUN_PREFLIGHT",
  "COMPILE_CONTEXT",
  "MATERIALIZE_CANDIDATE",
  "PLAN_VERIFICATION",
  "RUN_VERIFICATION_CHECK",
  "PREPARE_REPAIR",
]);

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
      const leased = await client.call({
        operationId: "leaseRunnerJob",
        body: jsonBody({
          schemaVersion: 1,
          runnerId: "faex1-worker",
          capabilitiesObjectDigest: identities.capabilityDigest,
          maxJobs: 1,
        }),
        headers: { "content-type": "application/json" },
      });
      if (stopping) {
        return;
      }
      const parsed = JSON.parse(leased.body.toString("utf8")) as {
        outcome?: string;
        retryAfterMs?: number;
        projectId?: string;
        operationId?: string;
        leaseToken?: string;
        leaseGeneration?: number;
      };
      if (parsed.outcome !== "LEASED" || parsed.operationId === undefined || parsed.projectId === undefined) {
        await sleep(parsed.retryAfterMs ?? 2000);
        continue;
      }
      const got = await client.call({
        operationId: "getOperation",
        pathParams: { projectId: parsed.projectId, operationId: parsed.operationId },
      });
      const operation = JSON.parse(got.body.toString("utf8")) as { kind?: string };
      const kind = operation.kind ?? "";
      if (!WORKER_KINDS.has(kind)) {
        await sleep(1000);
        continue;
      }
      await client.call({
        operationId: "heartbeatOperation",
        pathParams: { projectId: parsed.projectId, operationId: parsed.operationId },
        body: jsonBody({
          schemaVersion: 1,
          leaseToken: parsed.leaseToken,
          leaseGeneration: parsed.leaseGeneration,
          observedInputObjectDigest: identities.capabilityDigest,
        }),
        headers: { "content-type": "application/json" },
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
