export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function optionalString(row: Record<string, unknown>, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function requiredInt(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function optionalInt(row: Record<string, unknown>, field: string): number | undefined {
  const value = row[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function requiredBlob(row: Record<string, unknown>, field: string): Buffer {
  const value = row[field];
  if (!Buffer.isBuffer(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function optionalBlob(row: Record<string, unknown>, field: string): Buffer | undefined {
  const value = row[field];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Buffer.isBuffer(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function rowOf(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} row`);
  }
  return value;
}
