export const CLASSIFICATION_SCANNER_VERSION = "pi-hec-classification/1.0.0";

export const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const RESTRICTED_FINDING_TYPES = [
  "private-key",
  "signing-key",
  "aws-access-key",
  "live-credential",
  "production-dump",
  "regulated-pii-ssn",
  "regulated-pii-pan",
] as const;

export const PERMITTED_FINDING_TYPES = ["email", "phone", "high-entropy"] as const;

export type RestrictedFindingType = (typeof RESTRICTED_FINDING_TYPES)[number];
export type PermittedFindingType = (typeof PERMITTED_FINDING_TYPES)[number];
export type SensitiveFindingType = RestrictedFindingType | PermittedFindingType;

export type SensitiveSpan = {
  findingType: SensitiveFindingType;
  classification: DataClassification;
  start: number;
  end: number;
};

const RANK: Readonly<Record<DataClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const PRIVATE_KEY =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
const AWS_KEY = /\bAKIA[A-Z0-9]{16}\b/g;
const LIVE_CREDENTIAL =
  /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9]{20,})\b/g;
const PRODUCTION_DUMP =
  /(?:^|\n)(?:--\s*PostgreSQL database dump|mysqldump:|-- Dumping data for table)/g;
const SSN = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const HIGH_ENTROPY_TOKEN = /\b[A-Za-z0-9+/=_\-]{32,}\b/g;
const SECRET_CONTEXT = /(?:password|secret|api[_-]?key|token|credential|private[_-]?key)/i;
const RESTRICTED_PATH =
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|.*\.pem|credentials\.json|\.env(?:\..+)?|.*-key\.pem)$/i;

export function classificationRank(value: DataClassification): number {
  return RANK[value];
}

export function maxClassification(
  values: readonly DataClassification[],
): DataClassification {
  let highest: DataClassification = "public";
  for (const value of values) {
    if (RANK[value] > RANK[highest]) {
      highest = value;
    }
  }
  return highest;
}

export function isRestrictedFindingType(value: string): value is RestrictedFindingType {
  return (RESTRICTED_FINDING_TYPES as readonly string[]).includes(value);
}

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let doubleIt = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const char = digits[index];
    if (char === undefined) {
      return false;
    }
    let n = Number(char);
    if (doubleIt) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

function pushMatches(
  text: string,
  pattern: RegExp,
  findingType: SensitiveFindingType,
  classification: DataClassification,
  into: SensitiveSpan[],
  accept: (matched: string, start: number) => boolean = () => true,
): void {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const matched = match[0];
    const start = match.index;
    if (matched.length > 0 && accept(matched, start)) {
      into.push({
        findingType,
        classification,
        start,
        end: start + matched.length,
      });
    }
    if (pattern.lastIndex === match.index) {
      pattern.lastIndex += 1;
    }
    match = pattern.exec(text);
  }
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function charsetClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/u.test(value)) {
    classes += 1;
  }
  if (/[A-Z]/u.test(value)) {
    classes += 1;
  }
  if (/\d/u.test(value)) {
    classes += 1;
  }
  if (/[^A-Za-z0-9]/u.test(value)) {
    classes += 1;
  }
  return classes;
}

function overlaps(left: SensitiveSpan, right: SensitiveSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function prefer(left: SensitiveSpan, right: SensitiveSpan): SensitiveSpan {
  const leftRestricted = left.classification === "restricted";
  const rightRestricted = right.classification === "restricted";
  if (leftRestricted !== rightRestricted) {
    return leftRestricted ? left : right;
  }
  const leftLen = left.end - left.start;
  const rightLen = right.end - right.start;
  if (leftLen !== rightLen) {
    return leftLen >= rightLen ? left : right;
  }
  return left.start <= right.start ? left : right;
}

export function collapseSpans(spans: readonly SensitiveSpan[]): SensitiveSpan[] {
  const sorted = [...spans].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return right.end - left.end;
  });
  const kept: SensitiveSpan[] = [];
  for (const span of sorted) {
    const index = kept.findIndex((item) => overlaps(item, span));
    if (index < 0) {
      kept.push(span);
      continue;
    }
    const existing = kept[index];
    if (existing === undefined) {
      kept.push(span);
      continue;
    }
    kept[index] = prefer(existing, span);
  }
  return kept.sort((left, right) => left.start - right.start);
}

export function scanSensitiveSpans(text: string): SensitiveSpan[] {
  const spans: SensitiveSpan[] = [];
  pushMatches(text, PRIVATE_KEY, "private-key", "restricted", spans);
  pushMatches(text, PRIVATE_KEY, "signing-key", "restricted", spans);
  pushMatches(text, AWS_KEY, "aws-access-key", "restricted", spans);
  pushMatches(text, LIVE_CREDENTIAL, "live-credential", "restricted", spans);
  pushMatches(text, PRODUCTION_DUMP, "production-dump", "restricted", spans);
  pushMatches(text, SSN, "regulated-pii-ssn", "restricted", spans);
  pushMatches(text, CARD_CANDIDATE, "regulated-pii-pan", "restricted", spans, (matched) => {
    const digits = matched.replace(/\D/g, "");
    return luhnValid(digits);
  });
  pushMatches(text, EMAIL, "email", "confidential", spans);
  pushMatches(text, PHONE, "phone", "confidential", spans);
  pushMatches(text, HIGH_ENTROPY_TOKEN, "live-credential", "restricted", spans, (matched, start) => {
    if (shannonEntropy(matched) < 4.2 || charsetClasses(matched) < 3) {
      return false;
    }
    const windowStart = Math.max(0, start - 48);
    const window = text.slice(windowStart, start);
    return SECRET_CONTEXT.test(window);
  });
  pushMatches(text, HIGH_ENTROPY_TOKEN, "high-entropy", "confidential", spans, (matched) => {
    if (shannonEntropy(matched) < 4.5 || charsetClasses(matched) < 3) {
      return false;
    }
    if (/^[A-Fa-f0-9]+$/u.test(matched) && matched.length < 40) {
      return false;
    }
    return true;
  });
  return collapseSpans(spans);
}

export function classifyPathName(path: string): DataClassification {
  if (RESTRICTED_PATH.test(path) || /(?:^|\/)secrets\//iu.test(path)) {
    return "restricted";
  }
  if (/(?:^|\/)(?:\.env|credentials|passwd|shadow)/iu.test(path)) {
    return "restricted";
  }
  const pathSpans = scanSensitiveSpans(path);
  return maxClassification(["public", ...pathSpans.map((span) => span.classification)]);
}

export function classifyText(text: string): {
  classification: DataClassification;
  spans: SensitiveSpan[];
} {
  const spans = scanSensitiveSpans(text);
  return {
    classification: maxClassification(["public", ...spans.map((span) => span.classification)]),
    spans,
  };
}

export function classifyContent(input: {
  path?: string;
  text: string;
  projectClassification?: DataClassification;
}): {
  classification: DataClassification;
  spans: SensitiveSpan[];
} {
  const textResult = classifyText(input.text);
  const pathClass = input.path === undefined ? "public" : classifyPathName(input.path);
  const project = input.projectClassification ?? "public";
  return {
    classification: maxClassification([textResult.classification, pathClass, project]),
    spans: textResult.spans,
  };
}
