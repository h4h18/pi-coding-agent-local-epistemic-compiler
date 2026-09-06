import { objectDigestFromBytes, type SnapshotId } from "@pi-hec/contracts";
import { evidenceIdFromNode, evidenceKindForUnit } from "./evidence-id.js";
import { INDEX_LIMITS, LimitError, assertWithinBudget } from "./limits.js";
import { interfaceFingerprint } from "./revision.js";
import { lineNumberAt, lineStartsOf } from "./text.js";
import type { IndexUnit, UnitKind } from "./types.js";

export type RawSpan = {
  kind: UnitKind;
  symbolId: string;
  charStart: number;
  charEnd: number;
  imports: readonly string[];
  exports: readonly string[];
  parentSymbol?: string;
  parentClasses?: readonly string[];
};

const JS_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "function",
  "class",
  "return",
  "throw",
  "with",
  "do",
  "else",
  "try",
  "finally",
  "typeof",
  "new",
  "await",
  "yield",
]);

function byteRange(
  text: string,
  charStart: number,
  charEnd: number,
): { byteStart: number; byteEnd: number } {
  const byteStart = Buffer.byteLength(text.slice(0, charStart), "utf8");
  const byteEnd = byteStart + Buffer.byteLength(text.slice(charStart, charEnd), "utf8");
  return { byteStart, byteEnd };
}

function skipJsTrivia(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      cursor += 1;
      continue;
    }
    if (text.startsWith("//", cursor)) {
      const nl = text.indexOf("\n", cursor);
      cursor = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function matchJsString(text: string, index: number): number {
  const quote = text[index];
  if (quote !== "'" && quote !== '"' && quote !== "`") {
    return index;
  }
  let cursor = index + 1;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (quote === "`" && text.startsWith("${", cursor)) {
      cursor += 2;
      let depth = 1;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "{") {
          depth += 1;
        } else if (text[cursor] === "}") {
          depth -= 1;
        }
        cursor += 1;
      }
      continue;
    }
    if (ch === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

function scanJsBlock(text: string, openBrace: number): number {
  let depth = 0;
  let cursor = openBrace;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "'" || ch === '"' || ch === "`") {
      cursor = matchJsString(text, cursor);
      continue;
    }
    if (text.startsWith("//", cursor)) {
      const nl = text.indexOf("\n", cursor);
      cursor = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      const end = text.indexOf("*/", cursor + 2);
      cursor = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return text.length;
}

function collectJsImportsExports(text: string): { imports: string[]; exports: string[] } {
  const imports: string[] = [];
  const exports: string[] = [];
  const fromRe = /\b(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match = fromRe.exec(text);
  while (match !== null) {
    const spec = match[1];
    if (spec !== undefined) {
      if (match[0].startsWith("import")) {
        imports.push(spec);
      } else {
        exports.push(spec);
      }
    }
    match = fromRe.exec(text);
  }
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let req = requireRe.exec(text);
  while (req !== null) {
    const spec = req[1];
    if (spec !== undefined) {
      imports.push(spec);
    }
    req = requireRe.exec(text);
  }
  const namedExport =
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  let named = namedExport.exec(text);
  while (named !== null) {
    const ident = named[1];
    if (ident !== undefined) {
      exports.push(ident);
    }
    named = namedExport.exec(text);
  }
  return { imports, exports };
}

function chunkJavascript(text: string): RawSpan[] {
  const { imports, exports } = collectJsImportsExports(text);
  const spans: RawSpan[] = [];
  let cursor = 0;
  let depth = 0;
  let currentClass: string | undefined;
  while (cursor < text.length) {
    cursor = skipJsTrivia(text, cursor);
    if (cursor >= text.length) {
      break;
    }
    const ch = text[cursor];
    if (ch === "'" || ch === '"' || ch === "`") {
      cursor = matchJsString(text, cursor);
      continue;
    }
    if (ch === "{") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        currentClass = undefined;
      }
      cursor += 1;
      continue;
    }
    const slice = text.slice(cursor);
    const classMatch = /^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(slice);
    if (classMatch !== null && depth === 0) {
      const name = classMatch[1] ?? "anonymous";
      const headerEnd = cursor + classMatch[0].length;
      const brace = text.indexOf("{", headerEnd);
      const end = brace === -1 ? headerEnd : scanJsBlock(text, brace);
      spans.push({
        kind: "class",
        symbolId: name,
        charStart: cursor,
        charEnd: end,
        imports,
        exports: exports.filter((item) => item === name),
      });
      currentClass = name;
      cursor = brace === -1 ? end : brace + 1;
      depth += brace === -1 ? 0 : 1;
      continue;
    }
    const fnMatch =
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(slice);
    if (fnMatch !== null && (depth === 0 || currentClass !== undefined)) {
      const name = fnMatch[1] ?? "anonymous";
      const headerEnd = cursor + fnMatch[0].length;
      const brace = text.indexOf("{", headerEnd);
      const end = brace === -1 ? headerEnd : scanJsBlock(text, brace);
      spans.push({
        kind: depth === 0 ? "function" : "method",
        symbolId: currentClass !== undefined ? `${currentClass}#${name}` : name,
        charStart: cursor,
        charEnd: end,
        imports,
        exports: depth === 0 ? exports.filter((item) => item === name) : [],
        ...(currentClass !== undefined ? { parentSymbol: currentClass } : {}),
      });
      cursor = end;
      continue;
    }
    if (currentClass !== undefined && depth === 1) {
      const method =
        /^(?:async\s+)?(?:static\s+)?(?:get|set|async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(
          slice,
        );
      if (method !== null) {
        const ident = method[1];
        if (ident !== undefined && !JS_KEYWORDS.has(ident)) {
          const header = method[0];
          const brace = text.indexOf("{", cursor + header.length);
          const end = brace === -1 ? cursor + header.length : scanJsBlock(text, brace);
          spans.push({
            kind: "method",
            symbolId: `${currentClass}#${ident}`,
            charStart: cursor,
            charEnd: end,
            imports,
            exports: [],
            parentSymbol: currentClass,
          });
          cursor = end;
          continue;
        }
      }
    }
    const constFn =
      /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(
        slice,
      );
    if (constFn !== null && depth === 0) {
      const name = constFn[1] ?? "anonymous";
      let end = cursor + constFn[0].length;
      const brace = text.indexOf("{", end - 1);
      if (brace !== -1 && brace < end + 2) {
        end = scanJsBlock(text, brace);
      } else {
        const semi = text.indexOf(";", end);
        const nl = text.indexOf("\n", end);
        end = semi === -1 ? (nl === -1 ? text.length : nl) : semi + 1;
      }
      spans.push({
        kind: "function",
        symbolId: name,
        charStart: cursor,
        charEnd: end,
        imports,
        exports: exports.filter((item) => item === name),
      });
      cursor = end;
      continue;
    }
    cursor += 1;
  }
  if (spans.length === 0) {
    spans.push({
      kind: "top-level",
      symbolId: "<file>",
      charStart: 0,
      charEnd: text.length,
      imports,
      exports,
    });
  }
  return spans;
}

function pythonBlockEnd(text: string, start: number): number {
  const lineEnd = text.indexOf("\n", start);
  if (lineEnd === -1) {
    return text.length;
  }
  const defLine = text.slice(text.lastIndexOf("\n", start) + 1, lineEnd);
  const indentMatch = /^(\s*)/.exec(defLine);
  const indent = indentMatch?.[1]?.length ?? 0;
  let cursor = lineEnd + 1;
  while (cursor < text.length) {
    const nextNl = text.indexOf("\n", cursor);
    const line = text.slice(cursor, nextNl === -1 ? text.length : nextNl);
    if (line.trim() === "" || line.trim().startsWith("#")) {
      cursor = nextNl === -1 ? text.length : nextNl + 1;
      continue;
    }
    const lineIndent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    if (lineIndent <= indent) {
      return cursor;
    }
    cursor = nextNl === -1 ? text.length : nextNl + 1;
  }
  return text.length;
}

function chunkPython(text: string): RawSpan[] {
  const imports: string[] = [];
  const importRe = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
  let imp = importRe.exec(text);
  while (imp !== null) {
    const spec = imp[1] ?? imp[2];
    if (spec !== undefined) {
      imports.push(spec);
    }
    imp = importRe.exec(text);
  }
  const spans: RawSpan[] = [];
  const classStack: { name: string; indent: number }[] = [];
  const declRe = /^( *)(class|def)\s+([A-Za-z_][\w]*)/gm;
  let match = declRe.exec(text);
  while (match !== null) {
    const indent = match[1]?.length ?? 0;
    const keyword = match[2];
    const name = match[3] ?? "anonymous";
    const start = match.index;
    const end = pythonBlockEnd(text, start);
    while (classStack.length > 0 && (classStack[classStack.length - 1]?.indent ?? 0) >= indent) {
      classStack.pop();
    }
    const parentClasses = classStack.map((item) => item.name);
    const parent = parentClasses[parentClasses.length - 1];
    if (keyword === "class") {
      spans.push({
        kind: "class",
        symbolId: name,
        charStart: start,
        charEnd: end,
        imports,
        exports: [name],
        ...(parent !== undefined ? { parentSymbol: parent, parentClasses } : {}),
      });
      classStack.push({ name, indent });
    } else {
      const isMethod = parent !== undefined;
      spans.push({
        kind: isMethod ? "method" : "function",
        symbolId: isMethod ? `${parent}#${name}` : name,
        charStart: start,
        charEnd: end,
        imports,
        exports: isMethod ? [] : [name],
        ...(parent !== undefined ? { parentSymbol: parent, parentClasses } : {}),
      });
    }
    match = declRe.exec(text);
  }
  if (spans.length === 0) {
    spans.push({
      kind: "top-level",
      symbolId: "<file>",
      charStart: 0,
      charEnd: text.length,
      imports,
      exports: [],
    });
  }
  return spans;
}

function chunkMarkdown(text: string): RawSpan[] {
  const spans: RawSpan[] = [];
  const heading = /^(#{1,6})\s+(.+)$/gm;
  const matches: { start: number; title: string }[] = [];
  let match = heading.exec(text);
  while (match !== null) {
    matches.push({ start: match.index, title: (match[2] ?? "section").trim() });
    match = heading.exec(text);
  }
  if (matches.length === 0) {
    return [
      {
        kind: "markdown-section",
        symbolId: "<document>",
        charStart: 0,
        charEnd: text.length,
        imports: [],
        exports: [],
      },
    ];
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    if (current === undefined) {
      continue;
    }
    spans.push({
      kind: "markdown-section",
      symbolId: current.title,
      charStart: current.start,
      charEnd: next?.start ?? text.length,
      imports: [],
      exports: [],
    });
  }
  return spans;
}

function skipJsonWs(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function scanJsonString(text: string, start: number): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "\\") {
      cursor += 2;
      continue;
    }
    if (ch === '"') {
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

function scanJsonValue(text: string, start: number): number {
  const index = skipJsonWs(text, start);
  const ch = text[index];
  if (ch === '"') {
    return scanJsonString(text, index);
  }
  if (ch === "{" || ch === "[") {
    const open = ch;
    const close = ch === "{" ? "}" : "]";
    let cursor = index + 1;
    let depth = 1;
    while (cursor < text.length && depth > 0) {
      const current = text[cursor];
      if (current === '"') {
        cursor = scanJsonString(text, cursor);
        continue;
      }
      if (current === open) {
        depth += 1;
      } else if (current === close) {
        depth -= 1;
      }
      cursor += 1;
    }
    return cursor;
  }
  if (text.startsWith("true", index)) {
    return index + 4;
  }
  if (text.startsWith("false", index)) {
    return index + 5;
  }
  if (text.startsWith("null", index)) {
    return index + 4;
  }
  let cursor = index;
  if (text[cursor] === "-") {
    cursor += 1;
  }
  while (cursor < text.length && /[0-9eE.+-]/.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function chunkJson(text: string): RawSpan[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const spans: RawSpan[] = [];
      let cursor = skipJsonWs(text, 0);
      if (text[cursor] === "{") {
        cursor += 1;
        while (cursor < text.length) {
          cursor = skipJsonWs(text, cursor);
          if (text[cursor] === "}") {
            break;
          }
          if (text[cursor] !== '"') {
            break;
          }
          const keyStart = cursor;
          const keyEnd = scanJsonString(text, cursor);
          const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
          cursor = skipJsonWs(text, keyEnd);
          if (text[cursor] !== ":") {
            break;
          }
          cursor += 1;
          const valueEnd = scanJsonValue(text, cursor);
          spans.push({
            kind: "schema-object",
            symbolId: key,
            charStart: keyStart,
            charEnd: valueEnd,
            imports: [],
            exports: [key],
          });
          cursor = skipJsonWs(text, valueEnd);
          if (text[cursor] === ",") {
            cursor += 1;
          }
        }
      }
      if (spans.length > 0) {
        return spans;
      }
    }
  } catch {
    // unparsable JSON falls through to a single schema span
  }
  return [
    {
      kind: "schema-object",
      symbolId: "<root>",
      charStart: 0,
      charEnd: text.length,
      imports: [],
      exports: [],
    },
  ];
}

function chunkConfig(text: string): RawSpan[] {
  const spans: RawSpan[] = [];
  const block = /^(?:\[([^\]]+)\]|([A-Za-z0-9_.-]+)\s*:)/gm;
  const matches: { start: number; name: string }[] = [];
  let match = block.exec(text);
  while (match !== null) {
    matches.push({ start: match.index, name: (match[1] ?? match[2] ?? "block").trim() });
    match = block.exec(text);
  }
  if (matches.length === 0) {
    return [
      {
        kind: "config-block",
        symbolId: "<root>",
        charStart: 0,
        charEnd: text.length,
        imports: [],
        exports: [],
      },
    ];
  }
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    if (current === undefined) {
      continue;
    }
    spans.push({
      kind: "config-block",
      symbolId: current.name,
      charStart: current.start,
      charEnd: next?.start ?? text.length,
      imports: [],
      exports: [current.name],
    });
  }
  return spans;
}

function chunkTests(text: string, language: string): RawSpan[] {
  const spans: RawSpan[] = [];
  const re = /(?:describe|it|test|suite)\s*\(\s*([`'"])([\s\S]*?)\1/g;
  let match = re.exec(text);
  while (match !== null) {
    const title = match[2] ?? "test";
    const start = match.index;
    const brace = text.indexOf("{", start);
    const end = brace === -1 ? start + match[0].length : scanJsBlock(text, brace);
    const fixtures = [...text.slice(start, end).matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (item) => item[1] ?? "",
    );
    spans.push({
      kind: "test",
      symbolId: title.slice(0, 200),
      charStart: start,
      charEnd: end,
      imports: fixtures.filter((item) => item.length > 0),
      exports: [],
    });
    match = re.exec(text);
  }
  if (spans.length === 0) {
    return chunkByLanguage(text, language);
  }
  return spans;
}

function fallbackWindows(text: string): RawSpan[] {
  const spans: RawSpan[] = [];
  const windowBytes = INDEX_LIMITS.fallbackWindowBytes;
  const overlap = INDEX_LIMITS.fallbackOverlapBytes;
  const total = Buffer.byteLength(text, "utf8");
  if (total === 0) {
    return [
      {
        kind: "fallback-window",
        symbolId: "<empty>",
        charStart: 0,
        charEnd: 0,
        imports: [],
        exports: [],
      },
    ];
  }
  let byteStart = 0;
  let index = 0;
  while (byteStart < total) {
    const byteEnd = Math.min(total, byteStart + windowBytes);
    let charStart = 0;
    let acc = 0;
    while (charStart < text.length && acc < byteStart) {
      acc += Buffer.byteLength(text[charStart] ?? "", "utf8");
      charStart += 1;
    }
    let charEnd = charStart;
    while (charEnd < text.length && acc < byteEnd) {
      acc += Buffer.byteLength(text[charEnd] ?? "", "utf8");
      charEnd += 1;
    }
    const nl = text.lastIndexOf("\n", charEnd);
    if (nl > charStart + 16) {
      charEnd = nl + 1;
    }
    spans.push({
      kind: "fallback-window",
      symbolId: `window-${String(index)}`,
      charStart,
      charEnd,
      imports: [],
      exports: [],
    });
    index += 1;
    if (byteEnd >= total) {
      break;
    }
    byteStart = Math.max(byteStart + 1, byteEnd - overlap);
  }
  return spans;
}

function chunkByLanguage(text: string, language: string): RawSpan[] {
  switch (language) {
    case "javascript":
    case "typescript":
      return chunkJavascript(text);
    case "python":
      return chunkPython(text);
    case "markdown":
      return chunkMarkdown(text);
    case "json":
      return chunkJson(text);
    case "yaml":
    case "toml":
      return chunkConfig(text);
    default:
      return fallbackWindows(text);
  }
}

export function buildUnitsFromSpans(
  input: {
    path: string;
    text: string;
    language: string;
    snapshotId: SnapshotId;
    category: string;
  },
  spans: readonly RawSpan[],
  producer: string,
): IndexUnit[] {
  const started = Date.now();
  const fileSpan: RawSpan = {
    kind: "file",
    symbolId: input.path,
    charStart: 0,
    charEnd: input.text.length,
    imports: spans[0]?.imports ?? [],
    exports: [...new Set(spans.flatMap((span) => [...span.exports]))],
  };
  const combined = [fileSpan, ...spans].slice(0, INDEX_LIMITS.maxUnitsPerFile);
  const lineStarts = lineStartsOf(input.text);
  const units: IndexUnit[] = [];
  let outputBytes = 0;
  for (const span of combined) {
    assertWithinBudget(started, `chunk ${input.path}`);
    const range = byteRange(input.text, span.charStart, span.charEnd);
    const slice = input.text.slice(span.charStart, span.charEnd);
    outputBytes += Buffer.byteLength(slice, "utf8");
    if (outputBytes > INDEX_LIMITS.maxOutputBytes) {
      throw new LimitError(`chunk ${input.path} exceeded output byte budget`);
    }
    const digest = objectDigestFromBytes(Buffer.from(slice, "utf8"));
    const identityKey =
      `${span.kind}:${input.path}:${String(range.byteStart)}:${String(range.byteEnd)}:${span.symbolId}`.slice(
        0,
        1024,
      );
    const ancestors =
      span.parentClasses ?? (span.parentSymbol !== undefined ? [span.parentSymbol] : []);
    const parentHierarchy = [input.path, ...ancestors];
    units.push({
      evidenceId: evidenceIdFromNode({
        snapshotId: input.snapshotId,
        kind: evidenceKindForUnit(span.kind),
        identityKey,
        contentObjectDigest: digest,
        provenanceIdentities: [`repo:${input.path}`],
      }),
      path: input.path,
      kind: span.kind,
      parentHierarchy,
      byteStart: range.byteStart,
      byteEnd: range.byteEnd,
      lineStart: lineNumberAt(lineStarts, span.charStart),
      lineEnd: lineNumberAt(lineStarts, Math.max(span.charStart, span.charEnd - 1)),
      contentDigest: digest,
      language: input.language,
      symbolId: span.symbolId,
      imports: span.imports,
      exports: span.exports,
      snapshotId: input.snapshotId,
      text: slice,
      producer,
      interfaceFingerprint: interfaceFingerprint(span.imports, span.exports),
    });
  }
  assertWithinBudget(started, `chunk ${input.path}`);
  return units;
}

export function chunkSource(input: {
  path: string;
  text: string;
  language: string;
  snapshotId: SnapshotId;
  category: string;
}): IndexUnit[] {
  const baseSpans =
    input.category === "test" &&
    (input.language === "javascript" || input.language === "typescript")
      ? chunkTests(input.text, input.language)
      : chunkByLanguage(input.text, input.language);
  return buildUnitsFromSpans(input, baseSpans, "pi-hec-structural-chunker/v1");
}
