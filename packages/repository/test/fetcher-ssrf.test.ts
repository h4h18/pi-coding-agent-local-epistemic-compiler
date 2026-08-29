import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import {
  FetchError,
  accumulateLimitedWire,
  fetchExternal,
  isForbiddenIp,
  memoryBlobPutter,
  type FetchTransport,
  type TlsSession,
} from "../src/index.js";

const PUBLIC_A = "8.8.8.8";
const PUBLIC_B = "1.1.1.1";
const NOW = "2026-08-28T00:00:00.000Z";

function httpResponse(input: {
  status: number;
  headers: readonly [string, string][];
  body: Uint8Array | string;
}): Uint8Array {
  const body = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
  const lines = [`HTTP/1.1 ${String(input.status)} OK`];
  for (const [name, value] of input.headers) {
    lines.push(`${name}: ${value}`);
  }
  if (!input.headers.some((pair) => pair[0].toLowerCase() === "content-length")) {
    lines.push(`Content-Length: ${String(body.byteLength)}`);
  }
  return Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), body]);
}

function mockTransport(input: {
  dns: Readonly<Record<string, readonly string[]>>;
  responses: Readonly<Record<string, Uint8Array>>;
  peerByAddress?: Readonly<Record<string, string>>;
}): { transport: FetchTransport; connects: string[] } {
  const connects: string[] = [];
  const transport: FetchTransport = {
    resolveDns: (hostname) => {
      const answers = input.dns[hostname];
      if (answers === undefined) {
        return Promise.reject(new Error(`no dns for ${hostname}`));
      }
      return Promise.resolve([...answers]);
    },
    openTls: (opts) => {
      if (isForbiddenIp(opts.address)) {
        return Promise.reject(new Error(`test must not connect to special address ${opts.address}`));
      }
      connects.push(`${opts.servername}|${opts.address}|${String(opts.port)}`);
      const peer = input.peerByAddress?.[opts.address] ?? opts.address;
      const session: TlsSession = {
        remoteAddress: peer,
        peerSpkiDer: new Uint8Array(32).fill(7),
        exchange: (request) => {
          const text = Buffer.from(request).toString("utf8");
          const host = /Host: ([^\r\n]+)/i.exec(text)?.[1] ?? opts.servername;
          const response = input.responses[host];
          if (response === undefined) {
            return Promise.reject(new Error(`no response for ${host}`));
          }
          return Promise.resolve(response);
        },
        close: () => undefined,
      };
      return Promise.resolve(session);
    },
  };
  return { transport, connects };
}

test("rejects credentials and secret-like query before any DNS or connect", async () => {
  const connects: string[] = [];
  const transport: FetchTransport = {
    resolveDns: () => Promise.reject(new Error("dns must not run")),
    openTls: () => {
      connects.push("called");
      return Promise.reject(new Error("connect must not run"));
    },
  };
  await expect(
    fetchExternal({
      requestedUrl: "https://user:pass@docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "CREDENTIALS" });
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/manual?access_token=secret",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "SECRET_QUERY" });
  expect(connects).toEqual([]);
});

test("HTTPS only and default port policy", async () => {
  const transport: FetchTransport = {
    resolveDns: () => Promise.reject(new Error("dns must not run")),
    openTls: () => Promise.reject(new Error("connect must not run")),
  };
  await expect(
    fetchExternal({
      requestedUrl: "http://docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "SCHEME" });
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com:8443/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "PORT" });
});

test("every redirect hop re-runs DNS and IP policy and records hops", async () => {
  const { transport, connects } = mockTransport({
    dns: {
      "a.example.com": [PUBLIC_A],
      "b.example.com": [PUBLIC_B],
      "c.example.com": [PUBLIC_A],
    },
    responses: {
      "a.example.com": httpResponse({
        status: 301,
        headers: [
          ["Location", "https://b.example.com/next"],
          ["Set-Cookie", "one=1"],
        ],
        body: "",
      }),
      "b.example.com": httpResponse({
        status: 302,
        headers: [["Location", "https://c.example.com/final"]],
        body: "",
      }),
      "c.example.com": httpResponse({
        status: 200,
        headers: [
          ["Content-Type", "text/plain; charset=utf-8"],
          ["Set-Cookie", "two=2"],
          ["Set-Cookie", "three=3"],
        ],
        body: "official docs",
      }),
    },
  });
  const result = await fetchExternal({
    requestedUrl: "https://a.example.com/start",
    putBlob: memoryBlobPutter().putBlob,
    nowIso: () => NOW,
    transport,
  });
  expect(result.trust).toBe("untrusted-data");
  expect(result.receipt.redirects).toHaveLength(2);
  expect(result.receipt.redirects[0]?.from).toContain("a.example.com");
  expect(result.receipt.redirects[0]?.to).toContain("b.example.com");
  expect(result.receipt.redirects[1]?.to).toContain("c.example.com");
  expect(result.receipt.finalUrl).toContain("c.example.com");
  expect(connects).toHaveLength(3);
  expect(connects.every((item) => !item.includes("127.") && !item.includes("10."))).toBe(true);
});

test("DNS rebinding to a private address is rejected before connect", async () => {
  const { transport, connects } = mockTransport({
    dns: {
      "docs.example.com": [PUBLIC_A],
      "evil.example.com": ["127.0.0.1"],
    },
    responses: {
      "docs.example.com": httpResponse({
        status: 302,
        headers: [["Location", "https://evil.example.com/steal"]],
        body: "",
      }),
    },
  });
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/start",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toBeInstanceOf(FetchError);
  expect(connects).toEqual([`docs.example.com|${PUBLIC_A}|443`]);
  expect(connects.some((item) => item.includes("127.0.0.1"))).toBe(false);
});

test("actual peer IP must be one of the validated public answers", async () => {
  const { transport } = mockTransport({
    dns: { "docs.example.com": [PUBLIC_A] },
    responses: {
      "docs.example.com": httpResponse({
        status: 200,
        headers: [["Content-Type", "text/plain"]],
        body: "ok",
      }),
    },
    peerByAddress: { [PUBLIC_A]: "10.0.0.1" },
  });
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "PEER_IP" });
});

test("literal special IPv4 and IPv6 addresses never connect", async () => {
  const transport: FetchTransport = {
    resolveDns: () => Promise.reject(new Error("dns must not run for forbidden literals")),
    openTls: () => Promise.reject(new Error("connect must not run")),
  };
  await expect(
    fetchExternal({
      requestedUrl: "https://127.0.0.1/meta",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "IP_POLICY" });
  await expect(
    fetchExternal({
      requestedUrl: "https://[2001:db8::1]/docs",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "IP_POLICY" });
  await expect(
    fetchExternal({
      requestedUrl: "https://169.254.169.254/latest/meta-data",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
    }),
  ).rejects.toMatchObject({ code: "IP_POLICY" });
});

test("duplicate Set-Cookie headers retain wire order and are not comma-folded", async () => {
  const { transport } = mockTransport({
    dns: { "docs.example.com": [PUBLIC_A] },
    responses: {
      "docs.example.com": httpResponse({
        status: 200,
        headers: [
          ["Content-Type", "text/plain"],
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ],
        body: "ok",
      }),
    },
  });
  const result = await fetchExternal({
    requestedUrl: "https://docs.example.com/manual",
    putBlob: memoryBlobPutter().putBlob,
    nowIso: () => NOW,
    transport,
  });
  const cookies = result.receipt.responseHeaders.filter((header) => header.nameLowercase === "set-cookie");
  expect(cookies.map((item) => item.value)).toEqual(["a=1", "b=2"]);
});

test("gzip compression bombs are rejected by decoded byte limits", async () => {
  const zeros = Buffer.alloc(3 * 1024 * 1024);
  const compressed = gzipSync(zeros);
  const { transport, connects } = mockTransport({
    dns: { "docs.example.com": [PUBLIC_A] },
    responses: {
      "docs.example.com": httpResponse({
        status: 200,
        headers: [
          ["Content-Type", "text/plain"],
          ["Content-Encoding", "gzip"],
        ],
        body: compressed,
      }),
    },
  });
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
      maxDecodedBytes: 64 * 1024,
    }),
  ).rejects.toMatchObject({ code: "LIMIT" });
  expect(connects).toEqual([`docs.example.com|${PUBLIC_A}|443`]);
});

test("version mismatch is recorded as a conflict and text stays untrusted", async () => {
  const { transport } = mockTransport({
    dns: { "docs.example.com": [PUBLIC_A] },
    responses: {
      "docs.example.com": httpResponse({
        status: 200,
        headers: [
          ["Content-Type", "text/html"],
          ["X-Documentation-Version", "9.9.9"],
        ],
        body: "<html><body>docs</body></html>",
      }),
    },
  });
  const result = await fetchExternal({
    requestedUrl: "https://docs.example.com/manual",
    putBlob: memoryBlobPutter().putBlob,
    nowIso: () => NOW,
    transport,
    declaredDependencyVersion: "1.2.3",
  });
  expect(result.trust).toBe("untrusted-data");
  expect(result.versionConflict).toBe(true);
  expect(result.receipt.declaredDependencyVersion).toBe("1.2.3");
  expect(result.receipt.observedDocumentationVersion).toBe("9.9.9");
});

test("connectedAddress is the actual socket remoteAddress after public-set validation", async () => {
  const mappedPeer = `::ffff:${PUBLIC_A}`;
  const { transport } = mockTransport({
    dns: { "docs.example.com": [PUBLIC_A] },
    responses: {
      "docs.example.com": httpResponse({
        status: 200,
        headers: [["Content-Type", "text/plain"]],
        body: "ok",
      }),
    },
    peerByAddress: { [PUBLIC_A]: mappedPeer },
  });
  const result = await fetchExternal({
    requestedUrl: "https://docs.example.com/manual",
    putBlob: memoryBlobPutter().putBlob,
    nowIso: () => NOW,
    transport,
  });
  expect(result.receipt.connectedAddress).toBe(mappedPeer);
  expect(result.receipt.resolvedPublicAddresses).toContain(PUBLIC_A);
});

test("streaming wire overflow aborts before later chunks are pulled", async () => {
  let aborted = false;
  let yielded = 0;
  async function* chunks(): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    yielded += 1;
    yield Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n", "latin1");
    yielded += 1;
    yield Buffer.alloc(80, 65);
    yielded += 1;
    yield Buffer.alloc(1_000_000, 66);
    throw new Error("generator continued after overflow");
  }
  await expect(
    accumulateLimitedWire(
      chunks(),
      { maxWireBytes: 60, maxDecodedBytes: 2 * 1024 * 1024, timeoutMs: 5_000 },
      () => {
        aborted = true;
      },
    ),
  ).rejects.toMatchObject({ code: "LIMIT" });
  expect(aborted).toBe(true);
  expect(yielded).toBe(2);
});

test("fetchExternal aborts an injected stream when wire limits overflow", async () => {
  let aborted = false;
  let yielded = 0;
  const transport: FetchTransport = {
    resolveDns: () => Promise.resolve([PUBLIC_A]),
    openTls: () => {
      const session: TlsSession = {
        remoteAddress: PUBLIC_A,
        peerSpkiDer: new Uint8Array(32).fill(7),
        exchange: (_request, limits) => {
          async function* chunks(): AsyncIterable<Uint8Array> {
            await Promise.resolve();
            yielded += 1;
            yield Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n", "latin1");
            yielded += 1;
            yield Buffer.alloc(200, 65);
            yielded += 1;
            yield Buffer.alloc(500_000, 66);
            throw new Error("generator continued after overflow");
          }
          return accumulateLimitedWire(chunks(), limits, () => {
            aborted = true;
          });
        },
        close: () => {
          aborted = true;
        },
      };
      return Promise.resolve(session);
    },
  };
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
      maxWireBytes: 80,
      maxDecodedBytes: 2 * 1024 * 1024,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ code: "LIMIT" });
  expect(aborted).toBe(true);
  expect(yielded).toBe(2);
});

test("stalled chunk stream times out even when abort does not end the iterable", async () => {
  let aborted = false;
  async function* chunks(): AsyncIterable<Uint8Array> {
            yield Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n", "latin1");
    await new Promise<void>(() => undefined);
  }
  await expect(
    accumulateLimitedWire(
      chunks(),
      { maxWireBytes: 1024, maxDecodedBytes: 1024, timeoutMs: 40 },
      () => {
        aborted = true;
      },
    ),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(aborted).toBe(true);
}, 2_000);

test("fetchExternal times out an injected stream that never sends end", async () => {
  const transport: FetchTransport = {
    resolveDns: () => Promise.resolve([PUBLIC_A]),
    openTls: () => {
      const session: TlsSession = {
        remoteAddress: PUBLIC_A,
        peerSpkiDer: new Uint8Array(32).fill(7),
        exchange: (_request, limits) => {
          async function* chunks(): AsyncIterable<Uint8Array> {
            yield Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npartial", "latin1");
            await new Promise<void>(() => undefined);
          }
          return accumulateLimitedWire(chunks(), limits, () => undefined);
        },
        close: () => undefined,
      };
      return Promise.resolve(session);
    },
  };
  await expect(
    fetchExternal({
      requestedUrl: "https://docs.example.com/manual",
      putBlob: memoryBlobPutter().putBlob,
      nowIso: () => NOW,
      transport,
      timeoutMs: 40,
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
}, 2_000);
