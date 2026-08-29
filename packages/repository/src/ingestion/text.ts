import { objectDigestFromBytes, type ObjectDigest } from "@pi-hec/contracts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function isBinaryBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8000));
  if (sample.includes(0)) {
    return true;
  }
  let suspicious = 0;
  for (const value of sample) {
    if (value < 9 || (value > 13 && value < 32) || value === 127) {
      suspicious += 1;
    }
  }
  return suspicious / sample.byteLength > 0.3;
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    return undefined;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.normalize("NFC");
  } catch {
    return undefined;
  }
}

export function contentDigestOf(bytes: Uint8Array): ObjectDigest {
  return objectDigestFromBytes(bytes);
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

export function lineNumberAt(lineStarts: readonly number[], byteOffset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const start = lineStarts[mid] ?? 0;
    const next = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (byteOffset < start) {
      high = mid - 1;
    } else if (byteOffset >= next) {
      low = mid + 1;
    } else {
      return mid + 1;
    }
  }
  return Math.max(1, low);
}

export function utf8Slice(text: string, start: number, end: number): string {
  return Buffer.from(text, "utf8").subarray(start, end).toString("utf8");
}

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
