import type { ObjectDigest, RunId } from "@pi-hec/contracts";

export type ApprovalAction =
  | "cloud-egress"
  | "command"
  | "workspace-promotion"
  | "project-trust"
  | "project-policy"
  | "workspace-registration";
import { escapeUntrustedText } from "./status-widget.js";

export const APPROVAL_PREVIEW_BANNER = "NON-AUTHORITATIVE PREVIEW — confirm in broker window";
const TRUNCATE_AT = 96;

export type ApprovalPreviewField = {
  label: string;
  value: string;
  provenance: string;
};

export type ApprovalPreview = {
  banner: typeof APPROVAL_PREVIEW_BANNER;
  runId: RunId | undefined;
  action: ApprovalAction;
  subjectObjectDigest: ObjectDigest;
  fields: readonly ApprovalPreviewField[];
};

export function truncateField(value: string, provenance: string): ApprovalPreviewField {
  const escaped = escapeUntrustedText(value);
  if (escaped.length <= TRUNCATE_AT) {
    return { label: provenance, value: escaped, provenance };
  }
  return {
    label: provenance,
    value: `${escaped.slice(0, TRUNCATE_AT)}…`,
    provenance: `local provenance: ${provenance}`,
  };
}

export function renderApprovalPreview(input: {
  runId?: RunId;
  action: ApprovalAction;
  subjectObjectDigest: ObjectDigest;
  extraFields?: ReadonlyArray<{ label: string; value: string }>;
}): ApprovalPreview {
  const fields = [
    truncateField(input.action, "action"),
    truncateField(input.subjectObjectDigest, "subjectObjectDigest"),
    ...(input.extraFields ?? []).map((field) => truncateField(field.value, field.label)),
  ];
  return {
    banner: APPROVAL_PREVIEW_BANNER,
    runId: input.runId,
    action: input.action,
    subjectObjectDigest: input.subjectObjectDigest,
    fields,
  };
}

export function formatApprovalPreview(preview: ApprovalPreview): string[] {
  const lines = [APPROVAL_PREVIEW_BANNER];
  if (preview.runId !== undefined) {
    lines.push(`run: ${escapeUntrustedText(preview.runId)}`);
  }
  for (const field of preview.fields) {
    lines.push(`${escapeUntrustedText(field.label)}: ${field.value}`);
    if (field.provenance.startsWith("local provenance:")) {
      lines.push(escapeUntrustedText(field.provenance));
    }
  }
  return lines;
}
