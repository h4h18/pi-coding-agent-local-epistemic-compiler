export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export type CanonicalizeOptions = {
  allowUnsafeIntegers: boolean;
};

const RFC8785_OPTIONS: CanonicalizeOptions = { allowUnsafeIntegers: true };
const CONTRACT_OPTIONS: CanonicalizeOptions = { allowUnsafeIntegers: false };

function rejectUnpairedSurrogates(value: string): void {
  if (UNPAIRED_SURROGATE.test(value)) {
    throw new CanonicalizationError("unpaired surrogate in string");
  }
}

function utf16Compare(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) {
      return a - b;
    }
  }
  return left.length - right.length;
}

function serializeNumber(value: number, options: CanonicalizeOptions): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("NaN and Infinity are not permitted");
  }
  if (!options.allowUnsafeIntegers && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CanonicalizationError("unsafe integer is not permitted");
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return JSON.stringify(value);
}

function walk(value: unknown, seen: WeakSet<object>, options: CanonicalizeOptions): string {
  if (value === undefined) {
    throw new CanonicalizationError("undefined is not permitted");
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new CanonicalizationError(`unsupported JSON type ${typeof value}`);
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return serializeNumber(value, options);
  }
  if (typeof value === "string") {
    rejectUnpairedSurrogates(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError("unsupported JSON value");
  }
  if (seen.has(value)) {
    throw new CanonicalizationError("cyclic structure");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalizationError("sparse array is not permitted");
        }
        items.push(walk(value[index], seen, options));
      }
      return `[${items.join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(utf16Compare);
    const parts: string[] = [];
    for (const key of keys) {
      rejectUnpairedSurrogates(key);
      parts.push(`${JSON.stringify(key)}:${walk(record[key], seen, options)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeRfc8785(value: unknown): string {
  return walk(value, new WeakSet(), RFC8785_OPTIONS);
}

export function canonicalize(value: unknown): string {
  return walk(value, new WeakSet(), CONTRACT_OPTIONS);
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function parseJsonString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') {
    throw new CanonicalizationError("expected string");
  }
  let index = start + 1;
  let raw = '"';
  while (index < text.length) {
    const char = text[index];
    if (char === undefined) {
      break;
    }
    raw += char;
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        throw new CanonicalizationError("unterminated escape");
      }
      raw += next;
      index += 2;
      continue;
    }
    if (char === '"') {
      const value = JSON.parse(raw) as string;
      rejectUnpairedSurrogates(value);
      return { value, next: index + 1 };
    }
    index += 1;
  }
  throw new CanonicalizationError("unterminated string");
}

function parseJsonValue(text: string, start: number): { value: unknown; next: number } {
  const index = skipWhitespace(text, start);
  const head = text[index];
  if (head === undefined) {
    throw new CanonicalizationError("unexpected end of JSON");
  }
  if (head === "{") {
    const object: Record<string, unknown> = {};
    const seenKeys = new Set<string>();
    let cursor = skipWhitespace(text, index + 1);
    if (text[cursor] === "}") {
      return { value: object, next: cursor + 1 };
    }
    while (cursor < text.length) {
      const parsedKey = parseJsonString(text, skipWhitespace(text, cursor));
      if (seenKeys.has(parsedKey.value)) {
        throw new CanonicalizationError(`duplicate object key ${parsedKey.value}`);
      }
      seenKeys.add(parsedKey.value);
      cursor = skipWhitespace(text, parsedKey.next);
      if (text[cursor] !== ":") {
        throw new CanonicalizationError("expected colon");
      }
      const parsedValue = parseJsonValue(text, cursor + 1);
      object[parsedKey.value] = parsedValue.value;
      cursor = skipWhitespace(text, parsedValue.next);
      if (text[cursor] === ",") {
        cursor += 1;
        continue;
      }
      if (text[cursor] === "}") {
        return { value: object, next: cursor + 1 };
      }
      throw new CanonicalizationError("expected comma or closing brace");
    }
    throw new CanonicalizationError("unterminated object");
  }
  if (head === "[") {
    const items: unknown[] = [];
    let cursor = skipWhitespace(text, index + 1);
    if (text[cursor] === "]") {
      return { value: items, next: cursor + 1 };
    }
    while (cursor < text.length) {
      const parsed = parseJsonValue(text, cursor);
      items.push(parsed.value);
      cursor = skipWhitespace(text, parsed.next);
      if (text[cursor] === ",") {
        cursor += 1;
        continue;
      }
      if (text[cursor] === "]") {
        return { value: items, next: cursor + 1 };
      }
      throw new CanonicalizationError("expected comma or closing bracket");
    }
    throw new CanonicalizationError("unterminated array");
  }
  if (head === '"') {
    return parseJsonString(text, index);
  }
  if (text.startsWith("true", index)) {
    return { value: true, next: index + 4 };
  }
  if (text.startsWith("false", index)) {
    return { value: false, next: index + 5 };
  }
  if (text.startsWith("null", index)) {
    return { value: null, next: index + 4 };
  }
  const numberMatch = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
    text.slice(index),
  );
  if (numberMatch?.[0] !== undefined) {
    const numeric = Number(numberMatch[0]);
    if (!Number.isFinite(numeric)) {
      throw new CanonicalizationError("non-finite JSON number");
    }
    return { value: numeric, next: index + numberMatch[0].length };
  }
  throw new CanonicalizationError("invalid JSON token");
}

export function parseCanonicalJsonText(text: string): unknown {
  if (text.length === 0) {
    throw new CanonicalizationError("empty JSON");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new CanonicalizationError("BOM is not permitted");
  }
  const parsed = parseJsonValue(text, 0);
  const trailing = skipWhitespace(text, parsed.next);
  if (trailing !== text.length) {
    throw new CanonicalizationError("trailing bytes after JSON value");
  }
  return parsed.value;
}

export function canonicalizeJsonText(
  text: string,
  options: CanonicalizeOptions = CONTRACT_OPTIONS,
): string {
  return walk(parseCanonicalJsonText(text), new WeakSet(), options);
}
