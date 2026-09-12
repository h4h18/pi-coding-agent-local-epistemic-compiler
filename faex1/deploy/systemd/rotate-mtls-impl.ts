import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeRotatedTestPki } from "../../../faex1/apps/control-plane/src/config.js";

export function rotateMtlsIdentities(outputDir: string): {
  outputDir: string;
  identities: readonly string[];
} {
  return writeRotatedTestPki(outputDir);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const dest = process.argv[2];
  if (dest === undefined) {
    throw new Error("usage: rotate-mtls-impl.ts <output-dir>");
  }
  rotateMtlsIdentities(dest);
}
