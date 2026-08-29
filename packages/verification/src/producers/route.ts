import { parseCompilerDiagnostics } from "./compiler-diagnostics.js";

export function producerIdsForStdout(text: string): readonly string[] {
  const ids: string[] = [];
  if (text.includes("<testcase") || text.includes("<testsuite")) {
    ids.push("junit");
  }
  if (/^TAP version/m.test(text) || /^(not )?ok\s+\d+/m.test(text)) {
    ids.push("tap");
  }
  if (looksLikeSarif(text)) {
    ids.push("sarif");
  }
  if (
    text.includes("end_of_record") ||
    text.includes("TN:") ||
    text.includes("<coverage") ||
    text.includes("cobertura")
  ) {
    ids.push("coverage");
  }
  if (parseCompilerDiagnostics(text).length > 0) {
    ids.push("compiler-diagnostics");
  }
  return ids;
}

export function looksLikeSarif(text: string): boolean {
  if (/"\$schema"\s*:\s*"[^"]*sarif/i.test(text)) {
    return true;
  }
  if (/"version"\s*:\s*"2\.1\.0"/.test(text) && /"runs"\s*:/.test(text) && /"results"\s*:/.test(text)) {
    return true;
  }
  return /sarif-schema/i.test(text);
}
