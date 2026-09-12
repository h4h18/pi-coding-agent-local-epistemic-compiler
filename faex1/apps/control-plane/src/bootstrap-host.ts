import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_ENROLL_PORT,
  DEFAULT_ETC_DIR,
  DEFAULT_LISTEN_HOST,
  DEFAULT_MTLS_PORT,
  writeHostRuntimeFiles,
} from "./host-runtime.js";

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : fallback;
}

export function bootstrapHostRuntime(): void {
  const etcDir = envOr("PI_HEC_ETC", DEFAULT_ETC_DIR);
  const listenHost = envOr("PI_HEC_LISTEN_HOST", DEFAULT_LISTEN_HOST);
  const mtlsPort = Number(envOr("PI_HEC_MTLS_PORT", String(DEFAULT_MTLS_PORT)));
  const enrollPort = Number(envOr("PI_HEC_ENROLL_PORT", String(DEFAULT_ENROLL_PORT)));
  const databasePath = envOr("PI_HEC_DB_PATH", "/var/lib/pi-hec/control/control.sqlite");
  const casRoot = envOr("PI_HEC_CAS_ROOT", "/var/lib/pi-hec/cas");
  const indexRoot = envOr("PI_HEC_INDEX_ROOT", "/var/lib/pi-hec/index");
  mkdirSync(etcDir, { recursive: true, mode: 0o700 });
  const identities = writeHostRuntimeFiles({
    etcDir,
    listenHost,
    mtlsPort,
    enrollPort,
    databasePath,
    casRoot,
    indexRoot,
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, etcDir, listenHost, mtlsPort, enrollPort, keyId: identities.keyId })}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bootstrapHostRuntime();
}
