import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { handleExternalFetch, handleRebuildIndex, handleSearchBm25 } from "../src/index.js";
import {
  PROJECT,
  cleanupTempDirs,
  fileEntry,
  memoryBlobs,
  snapshotOf,
  tempDir,
  utf8,
} from "../../../packages/repository/test/helpers.js";
import { memoryBlobPutter, type FetchTransport, type TlsSession } from "@pi-hec/repository";

afterEach(async () => {
  await cleanupTempDirs();
});

test("index handler rebuilds and BM25 search finds the token", async () => {
  const blobs = memoryBlobs();
  const manifest = snapshotOf([fileEntry("README.md", utf8("fnordwidget documentation\n"), blobs)]);
  const dir = await tempDir("pi-hec-cw-idx-");
  const dbPath = path.join(dir, "index.db");
  const rebuilt = await handleRebuildIndex({
    dbPath,
    projectId: PROJECT,
    manifest,
    getBlob: blobs.getBlob,
  });
  expect(rebuilt.evidenceIds.length).toBeGreaterThan(0);
  const hits = handleSearchBm25(dbPath, "fnordwidget");
  expect(hits.some((hit) => hit.path === "README.md")).toBe(true);
});

test("fetch handler returns an untrusted receipt over a mocked public hop", async () => {
  const session: TlsSession = {
    remoteAddress: "8.8.8.8",
    peerSpkiDer: new Uint8Array(32).fill(3),
    exchange: () =>
      Promise.resolve(
        Buffer.from(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nbody",
          "utf8",
        ),
      ),
    close: () => undefined,
  };
  const transport: FetchTransport = {
    resolveDns: () => Promise.resolve(["8.8.8.8"]),
    openTls: () => Promise.resolve(session),
  };
  const result = await handleExternalFetch({
    requestedUrl: "https://docs.example.com/manual",
    putBlob: memoryBlobPutter().putBlob,
    nowIso: () => "2026-08-28T00:00:00.000Z",
    transport,
  });
  expect(result.trust).toBe("untrusted-data");
  expect(result.receipt.status).toBe(200);
});
