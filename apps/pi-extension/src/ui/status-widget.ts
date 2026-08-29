import { Box, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { RunProjection } from "@pi-hec/contracts";
import {
  COMPATIBILITY_UNCONFINED,
  HEC_RUN_POINTER_TYPE,
  parsePointer,
  type HecRunPointer,
} from "../session-pointer.js";

const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/gu;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const ESC = /\u001b./gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu;
const C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function escapeUntrustedText(value: string): string {
  return value
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC, "")
    .replace(BIDI, "\uFFFD")
    .replace(C0, "\uFFFD")
    .replace(/\bhttps?:/giu, "http\u200B:")
    .replace(/\bfile:/giu, "file\u200B:")
    .replace(/\bwww\./giu, "www\u200B.");
}

export function renderStatusLines(pointer: HecRunPointer, run: RunProjection | undefined): string[] {
  const lines = ["HEC"];
  const runId = run?.runId ?? pointer.activeRunId ?? undefined;
  if (runId !== undefined && runId !== null) {
    lines.push(runId);
  }
  if (run?.state !== undefined) {
    lines.push(`state ${run.state}`);
  }
  if (run?.snapshotId !== undefined) {
    lines.push(`snapshot ${run.snapshotId}`);
  }
  if (pointer.controlEndpointIdentity.length > 0) {
    lines.push(`endpoint ${pointer.controlEndpointIdentity}`);
  }
  if (pointer.uiPreferences.confinementMark === COMPATIBILITY_UNCONFINED) {
    lines.push(COMPATIBILITY_UNCONFINED);
  }
  return lines.map(escapeUntrustedText);
}

export function createStatusEntryRenderer(getLastRun: () => RunProjection | undefined): EntryRenderer<unknown> {
  return (entry, _options, theme) => {
    const pointer = parsePointer(entry.data);
    if (pointer === undefined) {
      return new Text(escapeUntrustedText("HEC pointer unavailable"), 0, 0);
    }
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    for (const line of renderStatusLines(pointer, getLastRun())) {
      box.addChild(new Text(theme.fg("accent", line), 0, 0));
    }
    return box;
  };
}

export function statusWidgetEntryType(): string {
  return HEC_RUN_POINTER_TYPE;
}
