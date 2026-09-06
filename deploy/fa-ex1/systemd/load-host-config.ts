import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSignedHostConfig } from "../../../apps/control-plane/src/config.js";

export function loadHostConfigBeforeDropPrivileges(
  filePath: string,
  publicKeyPem: string,
  expectedKeyId: string,
): void {
  loadSignedHostConfig({
    filePath,
    publicKey: createPublicKey(publicKeyPem),
    expectedKeyId,
    services: {},
    privilegesDropped: false,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const filePath = process.argv[2];
  const keyPath = process.argv[3];
  const keyId = process.argv[4];
  if (filePath === undefined || keyPath === undefined || keyId === undefined) {
    throw new Error("usage: load-host-config.ts <host-config.json> <host-config.pub.pem> <key-id>");
  }
  loadHostConfigBeforeDropPrivileges(filePath, readFileSync(keyPath, "utf8"), keyId);
}
