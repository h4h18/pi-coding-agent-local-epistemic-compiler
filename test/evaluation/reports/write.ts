import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN_PREFIXES = ["http://", "https://", "http:", "https:"];

export function assertLocalReportPath(target: string): string {
  const resolved = path.resolve(target);
  const asUrl = target.trim().toLowerCase();
  if (FORBIDDEN_PREFIXES.some((prefix) => asUrl.startsWith(prefix))) {
    throw new Error("evaluation reports must be local files");
  }
  if (resolved.includes("://")) {
    throw new Error("evaluation reports must be local files");
  }
  return resolved;
}

export async function writeLocalReports(
  directory: string,
  documents: Readonly<Record<string, unknown>>,
): Promise<readonly string[]> {
  const root = assertLocalReportPath(directory);
  await mkdir(root, { recursive: true });
  const written: string[] = [];
  for (const [name, payload] of Object.entries(documents)) {
    if (name.includes("..") || name.includes("/") || name.includes("\\")) {
      throw new Error("report names must be local basenames");
    }
    const filePath = path.join(root, name);
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    written.push(filePath);
  }
  return written;
}

export function reportTelemetryDenied(): { readonly network: false; readonly prometheus: false; readonly otel: false } {
  return { network: false, prometheus: false, otel: false };
}
