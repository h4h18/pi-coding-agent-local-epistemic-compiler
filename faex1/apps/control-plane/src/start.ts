import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSignedHostConfig } from "./config.js";
import { listenControlPlane } from "./app.js";
import { DEFAULT_ETC_DIR, HOST_CONFIG_KEY_ID, loadHostRuntime } from "./host-runtime.js";

async function start(): Promise<void> {
  const etcDir = process.env.PI_HEC_ETC ?? DEFAULT_ETC_DIR;
  loadSignedHostConfig({
    filePath: path.join(etcDir, "host-config.json"),
    publicKey: createPublicKey(readFileSync(path.join(etcDir, "host-config.pub.pem"), "utf8")),
    expectedKeyId: HOST_CONFIG_KEY_ID,
    services: {},
    privilegesDropped: false,
  });
  const runtime = loadHostRuntime(etcDir);
  const listening = await listenControlPlane(runtime.ctx, runtime.controlConfig);
  const shutdown = (): void => {
    void listening.close().then(() => runtime.store.close());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mtlsUrl: listening.mtlsUrl,
      enrollUrl: listening.enrollUrl,
    })}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void start();
}
