import { ChangeSetError } from "./errors.js";

export type LogicalLine = {
  text: string;
  ending: string;
};

export type TextPatchOptions = {
  unifiedDiff: string;
  path: string;
  insertedLineEnding: "LF" | "CRLF";
  finalNewline: "PRESENT" | "ABSENT";
};

const HUNK_HEADER =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function normalizeDiff(diff: string): string {
  return diff.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function headerPath(line: string, kind: "---" | "+++"): string {
  if (!line.startsWith(kind)) {
    throw new ChangeSetError("TEXT_PATCH_HEADER", `expected ${kind} header`);
  }
  let rest = line.slice(kind.length).trimStart();
  const tab = rest.indexOf("\t");
  if (tab >= 0) {
    rest = rest.slice(0, tab);
  }
  if ((rest.startsWith('"') && rest.endsWith('"')) || (rest.startsWith("'") && rest.endsWith("'"))) {
    rest = rest.slice(1, -1);
  }
  if (rest === "/dev/null") {
    return "/dev/null";
  }
  if (rest.startsWith("a/") || rest.startsWith("b/")) {
    rest = rest.slice(2);
  }
  return rest;
}

function preludePaths(line: string): { from: string; to: string } | undefined {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (match === null) {
    return undefined;
  }
  return { from: match[1] ?? "", to: match[2] ?? "" };
}

function isIgnorableGitHeader(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("dissimilarity index ")
  );
}

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: readonly { kind: "context" | "delete" | "add"; text: string }[];
};

type HunkMarker = " " | "-" | "+" | "\\";

function isHunkMarker(marker: string): marker is HunkMarker {
  return marker === " " || marker === "-" || marker === "+" || marker === "\\";
}

function parseHunkBodyLine(
  bodyLine: string,
  path: string,
): { kind: "context" | "delete" | "add"; text: string } {
  if (bodyLine.length === 0) {
    throw new ChangeSetError("TEXT_PATCH_HUNK", `illegal hunk marker in ${path}`);
  }
  const marker = bodyLine.charAt(0);
  if (!isHunkMarker(marker)) {
    throw new ChangeSetError("TEXT_PATCH_HUNK", `illegal hunk marker in ${path}`);
  }
  switch (marker) {
    case " ":
      return { kind: "context", text: bodyLine.slice(1) };
    case "-":
      return { kind: "delete", text: bodyLine.slice(1) };
    case "+":
      return { kind: "add", text: bodyLine.slice(1) };
    case "\\":
      throw new ChangeSetError(
        "TEXT_PATCH_HUNK",
        `backslash newline markers are forbidden; use finalNewline for ${path}`,
      );
    default: {
      const exhaustive: never = marker;
      throw new ChangeSetError("TEXT_PATCH_HUNK", `unhandled hunk marker: ${String(exhaustive)}`);
    }
  }
}

function parseHunks(lines: readonly string[], start: number, path: string): Hunk[] {
  const hunks: Hunk[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      index += 1;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      throw new ChangeSetError("TEXT_PATCH_HEADER", `unexpected patch line for ${path}: ${line}`);
    }
    const oldStart = Number.parseInt(header[1] ?? "0", 10);
    const oldCount = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
    const newStart = Number.parseInt(header[3] ?? "0", 10);
    const newCount = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
    index += 1;
    const body: { kind: "context" | "delete" | "add"; text: string }[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (oldSeen < oldCount || newSeen < newCount) {
      const bodyLine = lines[index];
      if (bodyLine === undefined) {
        throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk truncated for ${path}`);
      }
      const parsed = parseHunkBodyLine(bodyLine, path);
      switch (parsed.kind) {
        case "context":
          if (oldSeen === oldCount || newSeen === newCount) {
            throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk counts mismatch for ${path}`);
          }
          oldSeen += 1;
          newSeen += 1;
          break;
        case "delete":
          if (oldSeen === oldCount) {
            throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk counts mismatch for ${path}`);
          }
          oldSeen += 1;
          break;
        case "add":
          if (newSeen === newCount) {
            throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk counts mismatch for ${path}`);
          }
          newSeen += 1;
          break;
        default: {
          const exhaustive: never = parsed.kind;
          throw new ChangeSetError("TEXT_PATCH_HUNK", `unhandled hunk body kind: ${String(exhaustive)}`);
        }
      }
      body.push(parsed);
      index += 1;
    }
    if (oldSeen !== oldCount || newSeen !== newCount) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk counts mismatch for ${path}`);
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, body });
  }
  if (hunks.length === 0) {
    throw new ChangeSetError("TEXT_PATCH_HUNK", `no hunks for ${path}`);
  }
  return hunks;
}

export function parseTextFile(bytes: Uint8Array): { bom: boolean; lines: LogicalLine[] } {
  if (bytes.includes(0)) {
    throw new ChangeSetError("TEXT_PATCH_ENCODING", "text_patch source contains NUL");
  }
  let offset = 0;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    offset = 3;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes.subarray(offset));
  } catch {
    throw new ChangeSetError("TEXT_PATCH_ENCODING", "text_patch requires valid UTF-8 without NUL");
  }
  const lines: LogicalLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const crlf = text.indexOf("\r\n", cursor);
    const lf = text.indexOf("\n", cursor);
    const cr = text.indexOf("\r", cursor);
    let next = text.length;
    let ending = "";
    if (crlf >= 0 && (lf < 0 || crlf <= lf) && (cr < 0 || crlf <= cr)) {
      next = crlf;
      ending = "\r\n";
    } else if (lf >= 0 && (cr < 0 || lf < cr)) {
      next = lf;
      ending = "\n";
    } else if (cr >= 0) {
      next = cr;
      ending = "\r";
    }
    lines.push({ text: text.slice(cursor, next), ending });
    cursor = next + ending.length;
  }
  if (text.length === 0) {
    return { bom, lines: [] };
  }
  if (
    !text.endsWith("\n") &&
    !text.endsWith("\r") &&
    (lines.length === 0 || (lines[lines.length - 1]?.ending ?? "") !== "")
  ) {
    lines.push({ text: "", ending: "" });
  }
  return { bom, lines };
}

function oldStartIndex(hunk: Hunk): number {
  return hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
}

function assertHunksOnOriginal(hunks: readonly Hunk[], oldLineCount: number, path: string): void {
  let lastStart = -1;
  let lastOccupiedEnd = 0;
  for (const hunk of hunks) {
    if (lastStart >= 0 && hunk.oldStart <= lastStart) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `hunks are not strictly increasing for ${path}`);
    }
    if (hunk.oldCount === 0) {
      if (hunk.oldStart === 0) {
        if (oldLineCount !== 0) {
          throw new ChangeSetError("TEXT_PATCH_HUNK", `@@ -0,0 is only valid for an empty file at ${path}`);
        }
      } else if (hunk.oldStart > oldLineCount) {
        throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk location out of range for ${path}`);
      }
      if (hunk.oldStart < lastOccupiedEnd) {
        throw new ChangeSetError("TEXT_PATCH_HUNK", `overlapping hunks for ${path}`);
      }
      lastStart = hunk.oldStart;
      lastOccupiedEnd = Math.max(lastOccupiedEnd, hunk.oldStart);
      continue;
    }
    if (hunk.oldStart < 1 || hunk.oldStart + hunk.oldCount - 1 > oldLineCount) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk location out of range for ${path}`);
    }
    if (hunk.oldStart < lastOccupiedEnd) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `overlapping hunks for ${path}`);
    }
    lastStart = hunk.oldStart;
    lastOccupiedEnd = hunk.oldStart + hunk.oldCount;
  }
}

function applyHunksOnOriginal(
  lines: readonly LogicalLine[],
  hunks: readonly Hunk[],
  insertedEnding: string,
  path: string,
): LogicalLine[] {
  assertHunksOnOriginal(hunks, lines.length, path);
  const output: LogicalLine[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const startIndex = oldStartIndex(hunk);
    if (startIndex < cursor || startIndex + hunk.oldCount > lines.length) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk location out of range for ${path}`);
    }
    output.push(...lines.slice(cursor, startIndex));
    let oldPtr = startIndex;
    for (const entry of hunk.body) {
      switch (entry.kind) {
        case "add":
          output.push({ text: entry.text, ending: insertedEnding });
          break;
        case "context":
        case "delete": {
          const current = lines[oldPtr];
          if (current === undefined || current.text !== entry.text) {
            throw new ChangeSetError(
              "TEXT_PATCH_HUNK",
              `exact hunk match failed for ${path} at line ${String(oldPtr + 1)}`,
            );
          }
          if (entry.kind === "context") {
            output.push(current);
          }
          oldPtr += 1;
          break;
        }
        default: {
          const exhaustive: never = entry.kind;
          throw new ChangeSetError("TEXT_PATCH_HUNK", `unhandled hunk body kind: ${String(exhaustive)}`);
        }
      }
    }
    if (oldPtr !== startIndex + hunk.oldCount) {
      throw new ChangeSetError("TEXT_PATCH_HUNK", `hunk did not consume expected old lines for ${path}`);
    }
    cursor = oldPtr;
  }
  output.push(...lines.slice(cursor));
  return output;
}

export function applyUnifiedDiff(bytes: Uint8Array, options: TextPatchOptions): Uint8Array {
  const diff = normalizeDiff(options.unifiedDiff);
  const rawLines = diff.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  let index = 0;
  while (index < rawLines.length && (rawLines[index] ?? "") === "") {
    index += 1;
  }
  const first = rawLines[index];
  if (first !== undefined) {
    const prelude = preludePaths(first);
    if (prelude !== undefined) {
      if (prelude.from !== options.path || prelude.to !== options.path) {
        throw new ChangeSetError("TEXT_PATCH_HEADER", "diff --git header path mismatch");
      }
      index += 1;
    }
  }
  while (index < rawLines.length && isIgnorableGitHeader(rawLines[index] ?? "")) {
    index += 1;
  }
  const minus = rawLines[index];
  const plus = rawLines[index + 1];
  if (minus === undefined || plus === undefined) {
    throw new ChangeSetError("TEXT_PATCH_HEADER", "missing ---/+++ headers");
  }
  const fromPath = headerPath(minus, "---");
  const toPath = headerPath(plus, "+++");
  if (fromPath === "/dev/null" || toPath === "/dev/null") {
    throw new ChangeSetError("TEXT_PATCH_HEADER", "text_patch cannot use /dev/null headers");
  }
  if (fromPath !== options.path || toPath !== options.path) {
    throw new ChangeSetError("TEXT_PATCH_HEADER", "unified diff headers must match path");
  }
  const hunks = parseHunks(rawLines, index + 2, options.path);
  const parsed = parseTextFile(bytes);
  const insertedEnding = options.insertedLineEnding === "CRLF" ? "\r\n" : "\n";
  const current = applyHunksOnOriginal(parsed.lines, hunks, insertedEnding, options.path);
  if (current.length === 0) {
    const empty = options.finalNewline === "PRESENT" ? insertedEnding : "";
    const payload = parsed.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(empty, "utf8")]) : Buffer.from(empty, "utf8");
    return new Uint8Array(payload);
  }
  const last = current[current.length - 1];
  if (last !== undefined) {
    if (options.finalNewline === "PRESENT" && last.ending === "") {
      current[current.length - 1] = { text: last.text, ending: insertedEnding };
    }
    if (options.finalNewline === "ABSENT") {
      current[current.length - 1] = { text: last.text, ending: "" };
    }
  }
  const chunks: Buffer[] = [];
  if (parsed.bom) {
    chunks.push(Buffer.from([0xef, 0xbb, 0xbf]));
  }
  for (const line of current) {
    chunks.push(Buffer.from(line.text, "utf8"), Buffer.from(line.ending, "utf8"));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
