import { lookup as dnsLookup } from "node:dns/promises";
import tls from "node:tls";
import { Compile } from "typebox/compile";
import {
  ExternalFetchReceiptSchema,
  objectDigestFromBytes,
  sha256Hex,
  type ExternalFetchReceipt,
  type ObjectDigest,
} from "@pi-hec/contracts";
import type { BlobPutter } from "../ingestion/types.js";
import { FetchError } from "./errors.js";
import { contentTypeMedia, firstHeader, type HeaderPair } from "./headers.js";
import {
  buildHttpRequest,
  parseHttpResponse,
  accumulateLimitedWire,
  type StreamLimits,
} from "./http.js";
import { classifyIp, isForbiddenIp, publicAddresses, canonicalPublicIp } from "./ip-policy.js";
import {
  assertAllowedMedia,
  observedVersionFrom,
  sanitizeFetchedText,
  sanitizerVersionDigest,
} from "./sanitizer.js";
import { evaluateFetchUrl, type HostPolicy } from "./url-policy.js";

const RECEIPT = Compile(ExternalFetchReceiptSchema);

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

export type TlsSession = {
  remoteAddress: string;
  peerSpkiDer: Uint8Array;
  exchange: (request: Uint8Array, limits: StreamLimits) => Promise<Uint8Array>;
  close: () => void;
};

export type FetchTransport = {
  resolveDns: (hostname: string) => Promise<readonly string[]>;
  openTls: (input: {
    servername: string;
    address: string;
    port: number;
    timeoutMs?: number;
  }) => Promise<TlsSession>;
};

export type ExternalFetchInput = {
  requestedUrl: string;
  putBlob: BlobPutter;
  nowIso: () => string;
  declaredDependencyVersion?: string;
  hostPolicy?: HostPolicy;
  transport?: FetchTransport;
  maxRedirects?: number;
  maxWireBytes?: number;
  maxDecodedBytes?: number;
  timeoutMs?: number;
};

export type ExternalFetchResult = {
  receipt: ExternalFetchReceipt;
  trust: "untrusted-data";
  versionConflict: boolean;
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export async function defaultResolveDns(hostname: string): Promise<string[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((item) => item.address);
}

export async function defaultOpenTls(input: {
  servername: string;
  address: string;
  port: number;
  timeoutMs?: number;
}): Promise<TlsSession> {
  if (isForbiddenIp(input.address)) {
    throw new FetchError("IP_POLICY", "refusing TLS connect to forbidden address");
  }
  const connectTimeoutMs = input.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: input.address,
      port: input.port,
      servername: input.servername,
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
    let settled = false;
    function failConnect(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy(error);
      reject(error);
    }
    const timer = setTimeout(() => {
      failConnect(new FetchError("TIMEOUT", "TLS connect timed out"));
    }, connectTimeoutMs);
    socket.on("error", () => undefined);
    socket.once("error", failConnect);
    socket.once("secureConnect", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const cert = socket.getPeerX509Certificate();
      if (cert === undefined) {
        const missing = new FetchError("TLS", "missing peer certificate");
        socket.destroy(missing);
        reject(missing);
        return;
      }
      const spki = cert.publicKey.export({ type: "spki", format: "der" });
      resolve({
        remoteAddress: socket.remoteAddress ?? "",
        peerSpkiDer: new Uint8Array(spki),
        exchange: async (request: Uint8Array, limits: StreamLimits) => {
          socket.write(request);
          return accumulateLimitedWire(tlsSocketChunks(socket, limits.timeoutMs), limits, () => {
            socket.destroy(new FetchError("TIMEOUT", "response read timed out"));
          });
        },
        close: () => {
          socket.destroy();
        },
      });
    });
  });
}

function tlsSocketChunks(socket: tls.TLSSocket, timeoutMs: number): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const queue: Buffer[] = [];
      const state: { ended: boolean; failure: Error | undefined } = {
        ended: false,
        failure: undefined,
      };
      let notify: (() => void) | undefined;
      const wake = (): void => {
        notify?.();
      };
      const finish = (): void => {
        state.ended = true;
        wake();
      };
      const fail = (error: Error): void => {
        state.failure = error;
        state.ended = true;
        wake();
      };
      const onData = (chunk: Buffer): void => {
        queue.push(chunk);
        wake();
      };
      const onTimeout = (): void => {
        const error = new FetchError("TIMEOUT", "TLS read timed out");
        socket.destroy(error);
        fail(error);
      };
      socket.on("data", onData);
      socket.once("end", finish);
      socket.once("close", finish);
      socket.once("error", fail);
      socket.once("timeout", onTimeout);
      socket.setTimeout(timeoutMs);
      try {
        while (!state.ended || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((wakeWait) => {
              notify = wakeWait;
            });
            notify = undefined;
            continue;
          }
          yield queue.shift() as Buffer;
        }
      } finally {
        socket.off("data", onData);
        socket.off("end", finish);
        socket.off("close", finish);
        socket.off("error", fail);
        socket.off("timeout", onTimeout);
        socket.setTimeout(0);
      }
      if (state.failure !== undefined) {
        throw state.failure;
      }
    },
  };
}

function spkiDigest(der: Uint8Array): ExternalFetchReceipt["tlsPeerSpkiSha256"] {
  return sha256Hex(der);
}

async function hop(
  url: string,
  policy: HostPolicy,
  transport: FetchTransport,
  limits: StreamLimits,
): Promise<{
  url: string;
  status: number;
  headers: HeaderPair[];
  body: Uint8Array;
  wireByteSize: number;
  decodedByteSize: number;
  resolvedPublicAddresses: string[];
  connectedAddress: string;
  tlsPeerSpkiSha256: ExternalFetchReceipt["tlsPeerSpkiSha256"];
}> {
  const parsed = evaluateFetchUrl(url, policy);
  const resolved = await transport.resolveDns(parsed.hostname);
  for (const address of resolved) {
    if (classifyIp(address) === "forbidden") {
      throw new FetchError("IP_POLICY", `DNS answer ${address} is forbidden`);
    }
  }
  const publicIps = publicAddresses(resolved);
  if (publicIps.length === 0) {
    throw new FetchError("IP_POLICY", "no public DNS answers");
  }
  const chosen = publicIps[0];
  if (chosen === undefined) {
    throw new FetchError("IP_POLICY", "no public DNS answers");
  }
  const session = await transport.openTls({
    servername: parsed.hostname,
    address: chosen,
    port: parsed.port,
    timeoutMs: limits.timeoutMs,
  });
  try {
    const peer = session.remoteAddress;
    const peerCanonical = canonicalPublicIp(peer);
    const validated = new Set(
      publicIps.map((ip) => canonicalPublicIp(ip)).filter((ip): ip is string => ip !== undefined),
    );
    if (peerCanonical === undefined || !validated.has(peerCanonical)) {
      throw new FetchError("PEER_IP", `peer address ${peer} is not a validated public answer`);
    }
    const request = buildHttpRequest({
      method: "GET",
      pathname: parsed.pathname,
      search: parsed.search,
      hostname: parsed.hostname,
    });
    const wire = await session.exchange(request, limits);
    const response = parseHttpResponse(wire, limits);
    return {
      url: parsed.href,
      status: response.status,
      headers: response.headers,
      body: response.body,
      wireByteSize: response.wireByteSize,
      decodedByteSize: response.decodedByteSize,
      resolvedPublicAddresses: publicIps,
      connectedAddress: peer,
      tlsPeerSpkiSha256: spkiDigest(session.peerSpkiDer),
    };
  } finally {
    session.close();
  }
}

export async function fetchExternal(input: ExternalFetchInput): Promise<ExternalFetchResult> {
  const policy = input.hostPolicy ?? {};
  const transport = input.transport ?? { resolveDns: defaultResolveDns, openTls: defaultOpenTls };
  const maxRedirects = input.maxRedirects ?? 5;
  const limits: StreamLimits = {
    maxWireBytes: input.maxWireBytes ?? 5 * 1024 * 1024,
    maxDecodedBytes: input.maxDecodedBytes ?? 2 * 1024 * 1024,
    timeoutMs: input.timeoutMs ?? 15_000,
  };
  evaluateFetchUrl(input.requestedUrl, policy);
  const redirects: ExternalFetchReceipt["redirects"] = [];
  let current = input.requestedUrl;
  let finalHop: Awaited<ReturnType<typeof hop>> | undefined;
  for (let hopIndex = 0; hopIndex <= maxRedirects; hopIndex += 1) {
    const result = await hop(current, policy, transport, limits);
    if (REDIRECT_STATUS.has(result.status)) {
      const location = firstHeader(result.headers, "location");
      if (location === undefined) {
        throw new FetchError("REDIRECT", "redirect missing Location");
      }
      const next = new URL(location, result.url);
      const from = result.url;
      const to = evaluateFetchUrl(next.href, policy).href;
      redirects.push({
        status: result.status as 301 | 302 | 303 | 307 | 308,
        from,
        to,
        resolvedPublicAddresses: result.resolvedPublicAddresses,
        connectedAddress: result.connectedAddress,
        tlsPeerSpkiSha256: result.tlsPeerSpkiSha256,
        responseHeaders: result.headers,
      });
      current = to;
      continue;
    }
    finalHop = result;
    break;
  }
  if (finalHop === undefined) {
    throw new FetchError("REDIRECT", "too many redirects");
  }
  const mediaType = contentTypeMedia(finalHop.headers) ?? sniffMedia(finalHop.body);
  assertAllowedMedia(mediaType);
  const sanitized = sanitizeFetchedText(mediaType, finalHop.body);
  const rawDigest = await input.putBlob(finalHop.body);
  const sanitizedDigest = await input.putBlob(Buffer.from(sanitized, "utf8"));
  const observed =
    observedVersionFrom(sanitized, finalHop.headers) ??
    observedVersionFrom(Buffer.from(finalHop.body).toString("utf8"), finalHop.headers);
  const versionConflict =
    input.declaredDependencyVersion !== undefined &&
    observed !== undefined &&
    input.declaredDependencyVersion !== observed;
  const receipt: ExternalFetchReceipt = {
    schemaVersion: 1,
    requestedUrl: evaluateFetchUrl(input.requestedUrl, policy).href,
    finalUrl: finalHop.url,
    redirects,
    fetchedAt: input.nowIso(),
    status: finalHop.status,
    resolvedPublicAddresses: finalHop.resolvedPublicAddresses,
    connectedAddress: finalHop.connectedAddress,
    tlsPeerSpkiSha256: finalHop.tlsPeerSpkiSha256,
    responseHeaders: finalHop.headers,
    wireByteSize: finalHop.wireByteSize,
    decodedByteSize: finalHop.decodedByteSize,
    mediaType,
    rawContentObjectDigest: rawDigest,
    sanitizedContentObjectDigest: sanitizedDigest,
    sanitizerVersionObjectDigest: sanitizerVersionDigest(),
    ...(input.declaredDependencyVersion !== undefined
      ? { declaredDependencyVersion: input.declaredDependencyVersion }
      : {}),
    ...(observed !== undefined ? { observedDocumentationVersion: observed } : {}),
  };
  if (!RECEIPT.Check(receipt)) {
    throw new FetchError("RECEIPT", "ExternalFetchReceipt schema invalid");
  }
  return { receipt, trust: "untrusted-data", versionConflict };
}

function sniffMedia(body: Uint8Array): string {
  const prefix = Buffer.from(body.subarray(0, 32)).toString("utf8").trimStart();
  if (prefix.startsWith("{") || prefix.startsWith("[")) {
    return "application/json";
  }
  if (prefix.startsWith("<")) {
    return "text/html";
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return "text/plain";
  } catch {
    throw new FetchError("MEDIA", "binary payload is unsupported");
  }
}

export function memoryBlobPutter(): {
  putBlob: BlobPutter;
  get: (digest: ObjectDigest) => Uint8Array | undefined;
} {
  const map = new Map<string, Uint8Array>();
  return {
    putBlob: (bytes) => {
      const digest = objectDigestFromBytes(bytes);
      map.set(digest, bytes);
      return Promise.resolve(digest);
    },
    get: (digest) => map.get(digest),
  };
}
