import type { KeyObject } from "node:crypto";
import { unsealSecret, type SealedSecret } from "../protocol.js";

export type SecretDestination =
  | { kind: "environment"; name: string }
  | { kind: "file"; relativePath: string; mode: "0400" };

export type SealedSecretInjection = {
  destination: SecretDestination;
  sealed: SealedSecret;
};

export function formatInjectLine(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  const trimmed = normalized.replace(/^\n+|\n+$/g, "");
  if (trimmed === "HEC_INJECT_BEGIN\nHEC_INJECT_END") {
    return "HEC_INJECT\n";
  }
  return `HEC_INJECT ${Buffer.from(normalized, "utf8").toString("base64")}\n`;
}

export function buildInjectText(
  env: Readonly<Record<string, string>>,
  files: readonly { relativePath: string; b64: string }[],
): string {
  const lines = ["HEC_INJECT_BEGIN"];
  for (const [name, value] of Object.entries(env)) {
    lines.push(`ENV ${name} ${Buffer.from(value, "utf8").toString("base64")}`);
  }
  for (const file of files) {
    lines.push(`FILE ${file.relativePath} 0400 ${file.b64}`);
  }
  lines.push("HEC_INJECT_END");
  return `${lines.join("\n")}\n`;
}

export function unsealInjections(input: {
  items: readonly SealedSecretInjection[];
  privateKey: KeyObject;
}): { text: string; zeroize: () => void } {
  const env: Record<string, string> = {};
  const files: { relativePath: string; b64: string }[] = [];
  const plains: Buffer[] = [];
  for (const item of input.items) {
    const plain = unsealSecret(item.sealed, input.privateKey);
    plains.push(plain);
    if (item.destination.kind === "environment") {
      env[item.destination.name] = plain.toString("utf8");
    } else {
      if (item.destination.relativePath.includes("..") || item.destination.relativePath.startsWith("/")) {
        plain.fill(0);
        continue;
      }
      files.push({ relativePath: item.destination.relativePath, b64: plain.toString("base64") });
    }
  }
  return {
    text: buildInjectText(env, files),
    zeroize: () => {
      for (const plain of plains) {
        plain.fill(0);
      }
    },
  };
}
