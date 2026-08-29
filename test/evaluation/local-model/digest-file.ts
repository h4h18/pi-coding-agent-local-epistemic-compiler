import { readFile } from "node:fs/promises";
import { sha256Hex } from "@pi-hec/contracts";

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return sha256Hex(bytes);
}

export function sha256Buffer(bytes: Buffer): string {
  return sha256Hex(bytes);
}
