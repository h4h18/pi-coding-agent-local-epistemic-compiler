import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ORACLE_LEAK_TOKENS = [
  "mustchange",
  "mustnotchange",
  "requiredbehavior",
  "forbiddenbehavior",
  "requiredevidence",
  "hidden-oracle",
  "hidden oracle",
  "solveredits",
  "gold patch",
  "gold-patch",
  "evaluation-only",
  "holdout",
  "this is an evaluation",
] as const;

function normalize(text: string): string {
  return text.toLowerCase().replaceAll("\r\n", "\n");
}

export function leakedOracleTokens(text: string): readonly string[] {
  const blob = normalize(text);
  return ORACLE_LEAK_TOKENS.filter((token) => blob.includes(token));
}

export function walkWorkspaceFiles(root: string): readonly string[] {
  const collected: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git" || entry === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (stat.isFile()) {
        collected.push(full);
      }
    }
  };
  visit(root);
  return collected;
}

export function posixFrom(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export function workspaceOracleLeaks(root: string): readonly {
  readonly path: string;
  readonly tokens: readonly string[];
}[] {
  const leaks: { path: string; tokens: readonly string[] }[] = [];
  for (const filePath of walkWorkspaceFiles(root)) {
    const tokens = leakedOracleTokens(readFileSync(filePath, "utf8"));
    if (tokens.length > 0) {
      leaks.push({ path: posixFrom(root, filePath), tokens });
    }
  }
  return leaks;
}

export function assertWorkspaceConcealed(root: string): void {
  const leaks = workspaceOracleLeaks(root);
  if (leaks.length > 0) {
    throw new Error(`oracle leaked into workspace: ${JSON.stringify(leaks)}`);
  }
}

export function promptLeaksOracle(prompt: string): boolean {
  return leakedOracleTokens(prompt).length > 0;
}
