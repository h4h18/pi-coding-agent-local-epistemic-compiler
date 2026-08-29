import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { FetchError } from "./errors.js";
import { parseRawHeaders, type HeaderPair } from "./headers.js";

export type StreamLimits = {
  maxWireBytes: number;
  maxDecodedBytes: number;
  timeoutMs: number;
};

export type HttpResponse = {
  status: number;
  headers: HeaderPair[];
  body: Uint8Array;
  wireByteSize: number;
  decodedByteSize: number;
};

const MAX_HEADER_BYTES = 64 * 1024;

export function parseHttpResponse(
  wire: Uint8Array,
  limits: { maxWireBytes: number; maxDecodedBytes: number },
): HttpResponse {
  if (wire.byteLength > limits.maxWireBytes) {
    throw new FetchError("LIMIT", "wire byte limit exceeded");
  }
  const split = indexOfDoubleCrlf(wire);
  if (split === -1) {
    throw new FetchError("HTTP", "incomplete HTTP headers");
  }
  const head = Buffer.from(wire.subarray(0, split)).toString("latin1");
  const bodyWire = wire.subarray(split + 4);
  const lines = head.split("\r\n");
  const statusLine = lines[0];
  if (statusLine === undefined) {
    throw new FetchError("HTTP", "missing status line");
  }
  const statusMatch = /^HTTP\/1\.[01] (\d{3}) /.exec(statusLine);
  const statusText = statusMatch?.[1];
  if (statusText === undefined) {
    throw new FetchError("HTTP", "invalid status line");
  }
  const status = Number(statusText);
  const raw: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new FetchError("HEADER", `invalid header line ${line}`);
    }
    raw.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (Buffer.byteLength(head, "latin1") > MAX_HEADER_BYTES) {
    throw new FetchError("LIMIT", "header size limit exceeded");
  }
  const headers = parseRawHeaders(raw);
  const encoding = headers.find((item) => item.nameLowercase === "content-encoding")?.value.toLowerCase();
  const transfer = headers.find((item) => item.nameLowercase === "transfer-encoding")?.value.toLowerCase();
  let payload = bodyWire;
  if (transfer === "chunked") {
    payload = decodeChunked(bodyWire);
  }
  const decoded = decompress(payload, encoding, limits.maxDecodedBytes);
  if (decoded.byteLength > limits.maxDecodedBytes) {
    throw new FetchError("LIMIT", "decoded byte limit exceeded");
  }
  return {
    status,
    headers,
    body: decoded,
    wireByteSize: wire.byteLength,
    decodedByteSize: decoded.byteLength,
  };
}

function indexOfDoubleCrlf(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor < body.byteLength) {
    const rest = Buffer.from(body.subarray(cursor));
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd === -1) {
      throw new FetchError("HTTP", "truncated chunked body");
    }
    const size = Number.parseInt(rest.subarray(0, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new FetchError("HTTP", "invalid chunk size");
    }
    if (size === 0) {
      break;
    }
    const dataStart = cursor + lineEnd + 2;
    const dataEnd = dataStart + size;
    if (dataEnd + 2 > body.byteLength) {
      throw new FetchError("HTTP", "truncated chunk");
    }
    parts.push(Buffer.from(body.subarray(dataStart, dataEnd)));
    cursor = dataEnd + 2;
  }
  return Buffer.concat(parts);
}

function decompress(payload: Uint8Array, encoding: string | undefined, maxDecodedBytes: number): Uint8Array {
  if (encoding === undefined || encoding === "identity") {
    if (payload.byteLength > maxDecodedBytes) {
      throw new FetchError("LIMIT", "decoded byte limit exceeded");
    }
    return payload;
  }
  const buf = Buffer.from(payload);
  const opts = { maxOutputLength: maxDecodedBytes };
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(buf, opts);
    }
    if (encoding === "deflate") {
      return inflateSync(buf, opts);
    }
    if (encoding === "br") {
      return brotliDecompressSync(buf, opts);
    }
  } catch (error) {
    throw new FetchError("LIMIT", error instanceof Error ? error.message : "decompression failed or exceeded limits");
  }
  throw new FetchError("MEDIA", `unsupported content-encoding ${encoding}`);
}

function abandonAsyncIterator(iterator: AsyncIterator<Uint8Array, unknown, unknown>): void {
  const closing = iterator.return?.();
  if (closing === undefined) {
    return;
  }
  void closing.then(
    () => undefined,
    () => undefined,
  );
}

export async function accumulateLimitedWire(
  chunks: AsyncIterable<Uint8Array>,
  limits: StreamLimits,
  abort: () => void,
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  let total = 0;
  let headerSplit = -1;
  let identityBody = true;
  const timeoutState = { timedOut: false };
  const iterator = chunks[Symbol.asyncIterator]();
  const timeoutError = new FetchError("TIMEOUT", "response read timed out");
  let rejectTimeout: (error: FetchError) => void = () => undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle = setTimeout(() => {
    timeoutState.timedOut = true;
    rejectTimeout(timeoutError);
    abort();
    abandonAsyncIterator(iterator);
  }, limits.timeoutMs);
  const nextChunk = (): Promise<IteratorResult<Uint8Array>> =>
    iterator.next().then(
      (result) => result,
      (error: unknown) => {
        if (timeoutState.timedOut) {
          return { done: true as const, value: undefined };
        }
        throw error;
      },
    );
  const pull = (): Promise<IteratorResult<Uint8Array>> => Promise.race([nextChunk(), timeoutPromise]);
  try {
    for (let next = await pull(); next.done !== true; next = await pull()) {
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > limits.maxWireBytes) {
        abort();
        throw new FetchError("LIMIT", "wire byte limit exceeded");
      }
      parts.push(Buffer.from(chunk));
      if (headerSplit === -1) {
        const preview = Buffer.concat(parts);
        headerSplit = indexOfDoubleCrlf(preview);
        if (headerSplit !== -1) {
          const head = preview.subarray(0, headerSplit).toString("latin1").toLowerCase();
          identityBody = !(head.includes("content-encoding:") && !/\bcontent-encoding:\s*identity\b/.test(head));
        }
      }
      if (headerSplit !== -1 && identityBody && total - headerSplit - 4 > limits.maxDecodedBytes) {
        abort();
        throw new FetchError("LIMIT", "decoded byte limit exceeded");
      }
    }
  } catch (error) {
    if (timeoutState.timedOut) {
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (timeoutState.timedOut) {
    throw timeoutError;
  }
  return Buffer.concat(parts);
}

export function buildHttpRequest(input: {
  method: string;
  pathname: string;
  search: string;
  hostname: string;
}): Uint8Array {
  const path = `${input.pathname}${input.search}`;
  const text = [
    `${input.method} ${path} HTTP/1.1`,
    `Host: ${input.hostname}`,
    "Accept: text/*, application/json, application/xml, application/javascript, application/yaml, application/toml",
    "Accept-Encoding: gzip, deflate, br",
    "User-Agent: pi-hec-external-fetcher/1",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return Buffer.from(text, "utf8");
}
