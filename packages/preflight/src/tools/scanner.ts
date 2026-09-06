export type PromotionSinks = {
  changeSetBuilder: (text: string) => void;
  promotionPath: (text: string) => void;
  egressHelper: (text: string) => void;
};

export type AnalystTrace = {
  taint: "untrusted-analyst-trace";
  text: string;
  scanReasons: readonly string[];
};

export type AnalystScan = {
  tainted: boolean;
  reasons: readonly string[];
};

export const LOCAL_TEXT_TAINT_MARKER = "[untrusted-analyst-trace]";

const PATTERNS: ReadonlyArray<{ reason: string; match: (text: string) => boolean }> = [
  { reason: "code-fence", match: (text) => text.includes("```") },
  {
    reason: "unified-diff",
    match: (text) => /(^|\n)--- [^\n]+\n\+\+\+ /u.test(text) || /(^|\n)@@ -\d+/u.test(text),
  },
  { reason: "shell-rm", match: (text) => text.includes("rm ") },
  { reason: "invoke-webrequest", match: (text) => text.includes("Invoke-WebRequest") },
  { reason: "bin-sh", match: (text) => text.includes("/bin/sh") },
  { reason: "apply-patch", match: (text) => /apply this patch/iu.test(text) },
  {
    reason: "secret-token",
    match: (text) => /\bsk-[A-Za-z0-9_-]{8,}\b/u.test(text) || /\bAKIA[A-Z0-9]{8,}\b/u.test(text),
  },
  { reason: "url", match: (text) => /https?:\/\//iu.test(text) },
  { reason: "fileContent", match: (text) => text.includes("fileContent") },
];

export function scanAnalystText(text: string): AnalystScan {
  const reasons: string[] = [];
  for (const pattern of PATTERNS) {
    if (pattern.match(text)) {
      reasons.push(pattern.reason);
    }
  }
  return { tainted: reasons.length > 0, reasons };
}

export function persistAnalystTrace(text: string, sinks?: PromotionSinks): AnalystTrace {
  void sinks;
  const scan = scanAnalystText(text);
  return {
    taint: "untrusted-analyst-trace",
    text,
    scanReasons: scan.reasons,
  };
}

export function sanitizeLocalText(text: string, sinks?: PromotionSinks): string {
  const trace = persistAnalystTrace(text, sinks);
  return trace.scanReasons.length > 0 ? LOCAL_TEXT_TAINT_MARKER : text;
}
