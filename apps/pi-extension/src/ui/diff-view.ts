import { escapeUntrustedText } from "./status-widget.js";

export const DIFF_TRUSTED_VIEW = "DIFF" as const;

export function diffViewNotice(runId: string): string {
  return escapeUntrustedText(`Opening broker DIFF view for ${runId}`);
}
