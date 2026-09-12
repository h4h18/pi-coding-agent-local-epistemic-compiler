import { createPublicKey } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSecretBroker } from "./main.js";

async function start(): Promise<void> {
  const etcDir = process.env.PI_HEC_ETC ?? "/etc/pi-hec";
  const endpoint = process.env.PI_HEC_BROKER_SOCKET ?? "/var/lib/pi-hec/broker/inject.sock";
  try {
    unlinkSync(endpoint);
  } catch {
    // first start
  }
  const handle = await startSecretBroker({
    endpoint,
    now: () => new Date().toISOString(),
    capabilityAuthorityPublicKey: createPublicKey(
      readFileSync(path.join(etcDir, "pki", "admin.sign.pub.pem"), "utf8"),
    ),
    secrets: new Map(),
  });
  const shutdown = (): void => {
    void handle.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write(`${JSON.stringify({ ok: true, endpoint: handle.endpoint })}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void start();
}
