import { EventEmitter } from "node:events";
import { expect, test } from "vitest";
import {
  BrokerClient,
  BrokerProtocolError,
  encodeFrame,
  isTrustedView,
  newGeneralId,
  readExact,
  sidFromBrokerEnv,
} from "../src/broker-client.js";
import { canonicalizeRfc8785 } from "@pi-hec/contracts";
import { QueueTransport, RUN_ID } from "./harness.js";

const HELLO = {
  protocolVersion: 1 as const,
  brokerInstanceId: "broker-1",
  connectionId: "conn-1",
  brokerNonce: "broker-nonce-value",
  maxFrameBytes: 1048576 as const,
  confinementRequired: true as const,
};

test("frames reject empty bodies and wrap RFC8785 requests after handshake", async () => {
  expect(() => encodeFrame(new Uint8Array())).toThrow(BrokerProtocolError);
  const transport = new QueueTransport([
    Buffer.from(canonicalizeRfc8785(HELLO), "utf8"),
    Buffer.from(
      canonicalizeRfc8785({
        requestId: "req_status",
        outcome: "RUN",
        run: {
          schemaVersion: 1,
          projectId: "proj1",
          runId: RUN_ID,
          workspaceId: "ws1",
          state: "CREATED",
          stateVersion: 0,
          artifactRoles: [],
          updatedAt: "2026-01-02T03:04:05.006Z",
        },
      }),
      "utf8",
    ),
  ]);
  const client = await BrokerClient.connect(transport, {
    claimedProcessId: 42,
    claimedProcessCreationTime: "2026-01-02T03:04:05.006Z",
    clientInstanceId: newGeneralId("client_"),
  });
  expect(client.connectionId).toBe("conn-1");
  const helloSent = JSON.parse(Buffer.from(transport.sent[0] ?? []).toString("utf8")) as {
    connectionId: string;
  };
  expect(helloSent.connectionId).toBe("conn-1");

  const response = await client.request({
    requestId: "req_status",
    method: "GET_RUN_STATUS",
    params: { runId: RUN_ID },
  });
  expect(response.outcome).toBe("RUN");
  const frame = JSON.parse(Buffer.from(transport.sent[1] ?? []).toString("utf8")) as {
    protocolVersion: number;
    sequence: number;
    body: { method: string };
  };
  expect(frame.protocolVersion).toBe(1);
  expect(frame.sequence).toBe(1);
  expect(frame.body.method).toBe("GET_RUN_STATUS");
});

test("broker-injected user SID is accepted and garbage is ignored", () => {
  expect(sidFromBrokerEnv("S-1-5-21-1-2-3-500")).toBe("S-1-5-21-1-2-3-500");
  expect(sidFromBrokerEnv("  S-1-5-21-1-2-3-500  ")).toBe("S-1-5-21-1-2-3-500");
  expect(sidFromBrokerEnv("not-a-sid")).toBeUndefined();
  expect(sidFromBrokerEnv("")).toBeUndefined();
  expect(sidFromBrokerEnv(undefined)).toBeUndefined();
});

test("unknown trusted view is never a sendable enum", () => {
  expect(isTrustedView("SECRETS")).toBe(false);
  expect(isTrustedView("RAW")).toBe(false);
});

test("requestId mismatch is rejected", async () => {
  const transport = new QueueTransport([
    Buffer.from(canonicalizeRfc8785(HELLO), "utf8"),
    Buffer.from(
      canonicalizeRfc8785({
        requestId: "req_other",
        outcome: "RUN",
        run: {
          schemaVersion: 1,
          projectId: "proj1",
          runId: RUN_ID,
          workspaceId: "ws1",
          state: "CREATED",
          stateVersion: 0,
          artifactRoles: [],
          updatedAt: "2026-01-02T03:04:05.006Z",
        },
      }),
      "utf8",
    ),
  ]);
  const client = await BrokerClient.connect(transport, {
    claimedProcessId: 42,
    claimedProcessCreationTime: "1970-01-01T00:00:00.000Z",
    clientInstanceId: newGeneralId("client_"),
  });
  await expect(
    client.request({
      requestId: "req_status",
      method: "GET_RUN_STATUS",
      params: { runId: RUN_ID },
    }),
  ).rejects.toThrow(/requestId mismatch/u);
});

class PartialSocket extends EventEmitter {
  destroyed = false;
  readableEnded = false;
  readableLength = 0;
  private queued: Buffer[];

  constructor(queued: Buffer[]) {
    super();
    this.queued = queued;
  }

  read(size: number): Buffer | null {
    const next = this.queued.shift();
    if (next === undefined) {
      this.readableLength = 0;
      return null;
    }
    if (next.byteLength > size) {
      this.queued.unshift(next.subarray(size));
      this.readableLength = this.queued.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      return next.subarray(0, size);
    }
    this.readableLength = this.queued.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    return next;
  }

  endNow(): void {
    this.readableEnded = true;
    this.emit("end");
  }
}

test("readExact fails closed when the pipe ends after partial data", async () => {
  const socket = new PartialSocket([Buffer.from([0x00, 0x00])]);
  const pending = readExact(socket as never, 4);
  queueMicrotask(() => {
    socket.endNow();
  });
  await expect(pending).rejects.toThrow(BrokerProtocolError);
});
