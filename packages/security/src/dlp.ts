import { createHash } from "node:crypto";
import {
  classifyContent,
  classifyPathName,
  isRestrictedFindingType,
  type DataClassification,
  type SensitiveFindingType,
  type SensitiveSpan,
} from "./classification.js";

export const DLP_SCANNER_VERSION = "pi-hec-dlp/1.0.0";

export type DlpFinding = {
  findingType: SensitiveFindingType;
  classification: DataClassification;
  start: number;
  end: number;
  marker: string;
  redactionPermitted: boolean;
  path?: string;
};

export type DlpScanResult = {
  classification: DataClassification;
  findings: readonly DlpFinding[];
  redactedText: string;
  inspectable: boolean;
};

export type EncodedContent =
  | { encoding: "utf-8"; text: string }
  | { encoding: "base64"; base64: string };

function utf8Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableRedactionMarker(findingType: string, literal: string): string {
  return `«REDACTED:${findingType}:${utf8Hex(literal).slice(0, 16)}»`;
}

function toFinding(text: string, span: SensitiveSpan, path?: string): DlpFinding {
  const literal = text.slice(span.start, span.end);
  const redactionPermitted = !isRestrictedFindingType(span.findingType);
  const finding: DlpFinding = {
    findingType: span.findingType,
    classification: span.classification,
    start: span.start,
    end: span.end,
    marker: stableRedactionMarker(span.findingType, literal),
    redactionPermitted,
  };
  if (path !== undefined) {
    return { ...finding, path };
  }
  return finding;
}

export function applyPermittedRedactions(text: string, findings: readonly DlpFinding[]): string {
  const permitted = [...findings]
    .filter((item) => item.redactionPermitted)
    .sort((left, right) => right.start - left.start);
  let redacted = text;
  for (const finding of permitted) {
    redacted = redacted.slice(0, finding.start) + finding.marker + redacted.slice(finding.end);
  }
  return redacted;
}

export function scanText(input: {
  text: string;
  path?: string;
  projectClassification?: DataClassification;
}): DlpScanResult {
  const classified = classifyContent({
    text: input.text,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.projectClassification === undefined
      ? {}
      : { projectClassification: input.projectClassification }),
  });
  const findings = classified.spans.map((span) => toFinding(input.text, span, input.path));
  return {
    classification: classified.classification,
    findings,
    redactedText: applyPermittedRedactions(input.text, findings),
    inspectable: true,
  };
}

function decodeBase64Strict(value: string): Buffer | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length === 0 || compact.length % 4 !== 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) {
    return undefined;
  }
  const decoded = Buffer.from(compact, "base64");
  const roundTrip = decoded.toString("base64").replace(/=+$/u, "");
  const compactTrim = compact.replace(/=+$/u, "");
  if (roundTrip !== compactTrim) {
    return undefined;
  }
  return decoded;
}

export function scanSourceContent(input: {
  content: EncodedContent;
  path?: string;
  projectClassification?: DataClassification;
}): DlpScanResult {
  if (input.content.encoding === "utf-8") {
    return scanText({
      text: input.content.text,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.projectClassification === undefined
        ? {}
        : { projectClassification: input.projectClassification }),
    });
  }
  const decoded = decodeBase64Strict(input.content.base64);
  if (decoded === undefined) {
    return {
      classification: "restricted",
      findings: [],
      redactedText: "",
      inspectable: false,
    };
  }
  const utf8 = decoded.toString("utf8");
  const latin1 = decoded.toString("latin1");
  const utf8Scan = scanText({
    text: utf8,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.projectClassification === undefined
      ? {}
      : { projectClassification: input.projectClassification }),
  });
  if (utf8 === latin1) {
    return utf8Scan;
  }
  const latin1Scan = scanText({
    text: latin1,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.projectClassification === undefined
      ? {}
      : { projectClassification: input.projectClassification }),
  });
  const merged = mergeDlpResults([utf8Scan, latin1Scan]);
  return { ...merged, redactedText: utf8Scan.redactedText };
}

export function scanPathName(path: string): DlpScanResult {
  const pathClass = classifyPathName(path);
  const textScan = scanText({ text: path, path });
  return {
    classification: pathClass === "restricted" ? "restricted" : textScan.classification,
    findings: textScan.findings,
    redactedText: textScan.redactedText,
    inspectable: textScan.inspectable,
  };
}

export function intendedPatchDependsOnRedacted(input: {
  findings: readonly DlpFinding[];
  intendedPatchPaths: readonly string[];
}): boolean {
  if (input.intendedPatchPaths.length === 0) {
    return false;
  }
  const targets = new Set(input.intendedPatchPaths);
  return input.findings.some(
    (finding) => finding.redactionPermitted && finding.path !== undefined && targets.has(finding.path),
  );
}

export function mergeDlpResults(results: readonly DlpScanResult[]): DlpScanResult {
  const findings = results.flatMap((item) => item.findings);
  let classification: DataClassification = "public";
  for (const item of results) {
    if (item.classification === "restricted") {
      classification = "restricted";
      break;
    }
    if (item.classification === "confidential") {
      classification = "confidential";
    } else if (item.classification === "internal" && classification === "public") {
      classification = "internal";
    }
  }
  return {
    classification,
    findings,
    redactedText: "",
    inspectable: results.every((item) => item.inspectable),
  };
}
