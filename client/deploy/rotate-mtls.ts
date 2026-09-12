import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function rotateMtlsIdentities(outputDir: string): { outputDir: string; status: number } {
  const script = path.resolve(
    fileURLToPath(new URL("../../faex1/deploy/systemd/rotate-mtls-impl.ts", import.meta.url)),
  );
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, outputDir], {
    stdio: "inherit",
  });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error("mTLS rotation failed");
  }
  return { outputDir, status };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const dest = process.argv[2];
  if (dest === undefined) {
    throw new Error("usage: rotate-mtls.ts <output-dir>");
  }
  rotateMtlsIdentities(dest);
}
