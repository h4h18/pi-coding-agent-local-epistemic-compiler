import type { JsonValue } from "./ids.js";

export class JsonConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonConversionError";
  }
}

export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  if (!isJsonObject(json)) {
    throw new JsonConversionError("value is not a JSON object");
  }
  return json;
}

export function toJsonValue(value: unknown): JsonValue {
  return convert(value, new WeakSet());
}

function convert(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonConversionError("non-finite number is not JSON");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new JsonConversionError(`value of type ${typeof value} is not JSON`);
  }
  if (seen.has(value)) {
    throw new JsonConversionError("cyclic structure is not JSON");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry: unknown) => convert(entry, seen));
    }
    const record: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = convert(entry, seen);
    }
    return record;
  } finally {
    seen.delete(value);
  }
}
