import { readFile } from "node:fs/promises";

export async function loadJsonl<T>(filePath: string): Promise<T[]> {
  const text = await readFile(filePath, "utf8");
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    rows.push(JSON.parse(line) as T);
  }
  return rows;
}
