import {
  sha256Utf8,
  type Digest,
  type EvidenceEdge,
  type EvidenceId,
  type EvidenceNode,
  type SnapshotId,
} from "@pi-hec/contracts";
import {
  asEvidenceId,
  asSnapshotId,
  compareUtf8,
  createEvidenceEdge,
  createEvidenceNode,
  isHistoricalNode,
  mergeProvenance,
} from "./graph.js";

export type DedupeSubject = {
  node: EvidenceNode;
  producer: string;
  blobDigest: string;
  scipSymbolId: string;
  fqSignature: string;
  astFingerprint: string;
  path: string;
  byteStart: number;
  byteEnd: number;
  generated: boolean;
  overloadKey: string;
  normalizedTextDigest: Digest;
};

export type DedupeResult = {
  subjects: readonly DedupeSubject[];
  nodes: readonly EvidenceNode[];
  edges: readonly EvidenceEdge[];
};

type WorkingSubject = DedupeSubject & { memberIds: EvidenceId[] };

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

function sameProducerBlob(left: DedupeSubject, right: DedupeSubject): boolean {
  return (
    left.producer === right.producer &&
    left.blobDigest === right.blobDigest &&
    left.blobDigest !== ""
  );
}

function commitIdentity(subject: DedupeSubject): string {
  if (!isHistoricalNode(subject.node)) {
    return "";
  }
  const match = /(?:^|\/)\.git\/commits\/([^/.]+)/.exec(subject.path);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  if (subject.node.kind === "commit" || subject.node.kind === "diff-hunk") {
    return subject.scipSymbolId;
  }
  return "";
}

function revisionMismatch(left: DedupeSubject, right: DedupeSubject): boolean {
  const leftHistorical = isHistoricalNode(left.node);
  const rightHistorical = isHistoricalNode(right.node);
  if (leftHistorical !== rightHistorical) {
    return true;
  }
  if (!leftHistorical) {
    return false;
  }
  if (left.blobDigest !== right.blobDigest && left.blobDigest !== "" && right.blobDigest !== "") {
    return true;
  }
  const leftCommit = commitIdentity(left);
  const rightCommit = commitIdentity(right);
  return leftCommit !== "" && rightCommit !== "" && leftCommit !== rightCommit;
}

function blockedPair(left: DedupeSubject, right: DedupeSubject): boolean {
  if (left.producer !== right.producer && !sameProducerBlob(left, right)) {
    return true;
  }
  if (revisionMismatch(left, right)) {
    return true;
  }
  if (left.generated !== right.generated) {
    return true;
  }
  if (left.generated && right.generated && left.path !== right.path) {
    return true;
  }
  if (
    left.overloadKey !== "" &&
    right.overloadKey !== "" &&
    left.overloadKey !== right.overloadKey
  ) {
    return true;
  }
  return false;
}

function sameScipOrFq(left: DedupeSubject, right: DedupeSubject): boolean {
  const scip = left.scipSymbolId !== "" && left.scipSymbolId === right.scipSymbolId;
  const fq = left.fqSignature !== "" && left.fqSignature === right.fqSignature;
  return scip || fq;
}

function snapshotIdOf(node: EvidenceNode): SnapshotId | undefined {
  for (const item of node.provenance) {
    if (item.source.origin === "repository") {
      return asSnapshotId(item.source.snapshotId);
    }
  }
  return undefined;
}

function remintNode(node: EvidenceNode, snapshotId: SnapshotId): EvidenceNode {
  return createEvidenceNode({
    snapshotId,
    kind: node.kind,
    identityKey: node.identityKey,
    authorship: node.authorship,
    label: node.label,
    status: node.status,
    trust: node.trust,
    provenance: node.provenance,
    estimatedTokens: node.estimatedTokens,
    ...(node.contentObjectDigest !== undefined
      ? { contentObjectDigest: node.contentObjectDigest }
      : {}),
  });
}

function mergeSubjects(left: WorkingSubject, right: WorkingSubject): WorkingSubject {
  const keep = compareUtf8(left.node.id, right.node.id) <= 0 ? left : right;
  const drop = keep === left ? right : left;
  const merged: EvidenceNode = {
    ...keep.node,
    provenance: mergeProvenance(keep.node.provenance, drop.node.provenance),
    estimatedTokens: Math.max(keep.node.estimatedTokens, drop.node.estimatedTokens),
    status:
      keep.node.status === "conflicted" || drop.node.status === "conflicted"
        ? "conflicted"
        : keep.node.status,
    trust: {
      ...keep.node.trust,
      independenceGroup: keep.node.trust.independenceGroup,
      adversarialRisk: Math.max(keep.node.trust.adversarialRisk, drop.node.trust.adversarialRisk),
      freshness: Math.min(keep.node.trust.freshness, drop.node.trust.freshness),
    },
  };
  const snapshotId = snapshotIdOf(merged) ?? snapshotIdOf(drop.node);
  if (snapshotId === undefined) {
    throw new Error("dedupe merge requires a repository snapshotId on provenance");
  }
  const node = remintNode(merged, snapshotId);
  return {
    ...keep,
    node,
    byteStart: Math.min(keep.byteStart, drop.byteStart),
    byteEnd: Math.max(keep.byteEnd, drop.byteEnd),
    memberIds: [...keep.memberIds, ...drop.memberIds],
  };
}

function unionFindMerge(
  subjects: WorkingSubject[],
  shouldMerge: (left: DedupeSubject, right: DedupeSubject) => boolean,
): WorkingSubject[] {
  const parent = subjects.map((_, index) => index);
  function find(index: number): number {
    const current = parent[index];
    if (current === undefined) {
      return index;
    }
    if (current !== index) {
      parent[index] = find(current);
    }
    return parent[index] ?? index;
  }
  function union(left: number, right: number): void {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) {
      parent[rootRight] = rootLeft;
    }
  }
  for (let i = 0; i < subjects.length; i += 1) {
    for (let j = i + 1; j < subjects.length; j += 1) {
      const left = subjects[i];
      const right = subjects[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (shouldMerge(left, right)) {
        union(i, j);
      }
    }
  }
  const groups = new Map<number, WorkingSubject[]>();
  for (let index = 0; index < subjects.length; index += 1) {
    const subject = subjects[index];
    if (subject === undefined) {
      continue;
    }
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(subject);
    groups.set(root, list);
  }
  const merged: WorkingSubject[] = [];
  for (const group of groups.values()) {
    const [head, ...rest] = group;
    if (head === undefined) {
      continue;
    }
    merged.push(rest.reduce((acc, item) => mergeSubjects(acc, item), head));
  }
  merged.sort((left, right) => compareUtf8(left.node.id, right.node.id));
  return merged;
}

function intervalContains(outer: DedupeSubject, inner: DedupeSubject): boolean {
  return (
    outer.path === inner.path &&
    outer.node.kind === inner.node.kind &&
    outer.byteStart <= inner.byteStart &&
    outer.byteEnd >= inner.byteEnd &&
    (outer.byteStart !== inner.byteStart || outer.byteEnd !== inner.byteEnd)
  );
}

export function normalizeCloneText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export function normalizedTextDigest(text: string): Digest {
  return sha256Utf8(normalizeCloneText(text));
}

export function parseParentHierarchy(raw: string): string[] {
  if (raw === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    return [raw];
  }
  return [raw];
}

export function fqSignatureFor(symbolId: string, interfaceFingerprint: string): string {
  if (symbolId === "") {
    return interfaceFingerprint;
  }
  if (interfaceFingerprint === "") {
    return symbolId;
  }
  return `${symbolId}#${interfaceFingerprint}`;
}

export function overloadKeyFor(symbolId: string, interfaceFingerprint: string): string {
  if (symbolId === "" && interfaceFingerprint === "") {
    return "";
  }
  return `${symbolId}:${interfaceFingerprint}`;
}

export function astFingerprintFor(input: {
  kind: string;
  language: string;
  symbolId: string;
  text: string;
  parentHierarchy: string;
}): string {
  const parents = parseParentHierarchy(input.parentHierarchy).filter(
    (item) => item !== input.symbolId && !item.includes("/"),
  );
  const stripped = input.symbolId === "" ? input.text : input.text.split(input.symbolId).join("");
  return sha256Utf8(
    `ast-tree-span\0${input.kind}\0${input.language}\0${parents.join("\0")}\0${normalizeCloneText(stripped)}`,
  );
}

export function subjectFromNode(node: EvidenceNode): DedupeSubject {
  let path = node.identityKey;
  let byteStart = 0;
  let byteEnd = 0;
  for (const item of node.provenance) {
    if (item.source.origin === "repository") {
      path = item.source.path;
      if (item.source.range.kind === "bytes") {
        byteStart = item.source.range.byteStart;
        byteEnd = item.source.range.byteEnd;
      }
      break;
    }
  }
  return {
    node,
    producer: node.provenance[0]?.extractorVersion ?? "unknown-producer",
    blobDigest: node.contentObjectDigest ?? "",
    scipSymbolId: "",
    fqSignature: "",
    astFingerprint: "",
    path,
    byteStart,
    byteEnd,
    generated: false,
    overloadKey: "",
    normalizedTextDigest: normalizedTextDigest(node.label),
  };
}

function toWorking(subject: DedupeSubject): WorkingSubject {
  return { ...subject, memberIds: [asEvidenceId(subject.node.id)] };
}

function stripWorking(subject: WorkingSubject): DedupeSubject {
  return {
    node: subject.node,
    producer: subject.producer,
    blobDigest: subject.blobDigest,
    scipSymbolId: subject.scipSymbolId,
    fqSignature: subject.fqSignature,
    astFingerprint: subject.astFingerprint,
    path: subject.path,
    byteStart: subject.byteStart,
    byteEnd: subject.byteEnd,
    generated: subject.generated,
    overloadKey: subject.overloadKey,
    normalizedTextDigest: subject.normalizedTextDigest,
  };
}

function replacementsFrom(subjects: readonly WorkingSubject[]): Map<EvidenceId, EvidenceId> {
  const replacements = new Map<EvidenceId, EvidenceId>();
  for (const subject of subjects) {
    const survivor = asEvidenceId(subject.node.id);
    for (const member of subject.memberIds) {
      replacements.set(member, survivor);
    }
  }
  return replacements;
}

export function dedupeSubjects(input: readonly DedupeSubject[]): DedupeSubject[] {
  return dedupeSubjectsWithMap(input).subjects;
}

function dedupeSubjectsWithMap(input: readonly DedupeSubject[]): {
  subjects: DedupeSubject[];
  replacements: Map<EvidenceId, EvidenceId>;
} {
  let current = input.map(toWorking);
  current = unionFindMerge(
    current,
    (left, right) =>
      !blockedPair(left, right) &&
      sameProducerBlob(left, right) &&
      left.blobDigest !== "" &&
      right.blobDigest !== "",
  );
  current = unionFindMerge(
    current,
    (left, right) => !blockedPair(left, right) && sameScipOrFq(left, right),
  );
  current = unionFindMerge(
    current,
    (left, right) =>
      !blockedPair(left, right) &&
      left.astFingerprint !== "" &&
      left.astFingerprint === right.astFingerprint,
  );
  current = unionFindMerge(
    current,
    (left, right) =>
      !blockedPair(left, right) &&
      left.producer === right.producer &&
      (intervalContains(left, right) || intervalContains(right, left)),
  );
  current = unionFindMerge(
    current,
    (left, right) =>
      !blockedPair(left, right) &&
      left.producer === right.producer &&
      left.normalizedTextDigest === right.normalizedTextDigest &&
      dirname(left.path) === dirname(right.path) &&
      !left.generated &&
      !right.generated,
  );
  return {
    subjects: current.map(stripWorking),
    replacements: replacementsFrom(current),
  };
}

export function remapEdges(
  edges: readonly EvidenceEdge[],
  replacements: ReadonlyMap<EvidenceId, EvidenceId>,
): EvidenceEdge[] {
  const rewritten: EvidenceEdge[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const fromKey = asEvidenceId(edge.from);
    const toKey = asEvidenceId(edge.to);
    const from = replacements.get(fromKey) ?? fromKey;
    const to = replacements.get(toKey) ?? toKey;
    if (from === to) {
      continue;
    }
    const next = createEvidenceEdge({
      from,
      to,
      relation: edge.relation,
      polarity: edge.polarity,
      confidence: edge.confidence,
      provenance: edge.provenance,
    });
    if (seen.has(next.id)) {
      continue;
    }
    seen.add(next.id);
    rewritten.push(next);
  }
  rewritten.sort((left, right) => compareUtf8(left.id, right.id));
  return rewritten;
}

export function dedupeEvidence(
  subjects: readonly DedupeSubject[],
  edges: readonly EvidenceEdge[],
): DedupeResult {
  const { subjects: merged, replacements } = dedupeSubjectsWithMap(subjects);
  return {
    subjects: merged,
    nodes: merged.map((item) => item.node),
    edges: remapEdges(edges, replacements),
  };
}
