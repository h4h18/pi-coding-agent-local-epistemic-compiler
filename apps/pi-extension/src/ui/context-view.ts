import { escapeUntrustedText } from "./status-widget.js";

export const CONTEXT_TRUSTED_VIEW = "CONTEXT" as const;

export function contextViewNotice(runId: string): string {
  return escapeUntrustedText(`Opening broker CONTEXT view for ${runId}`);
}
