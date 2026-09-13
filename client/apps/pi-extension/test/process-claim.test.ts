import { expect, test } from "vitest";
import { canonicalizeRfc8785 } from "@pi-hec/contracts";
import {
  BrokerClient,
  filetimeEpochParts,
  filetimePartsToRfc3339,
  newGeneralId,
  unixMillisToRfc3339,
} from "../src/broker-client.js";
import { createProcessClaim, readCurrentProcessIsAppContainer } from "../src/broker-windows.js";
import { createHecExtension } from "../src/index.js";
import { defaultConfinementProbe } from "../src/session-pointer.js";
import { FakePi, QueueTransport } from "./harness.js";

const HELLO = {
  protocolVersion: 1 as const,
  brokerInstanceId: "broker-1",
  connectionId: "conn-1",
  brokerNonce: "broker-nonce-value",
  maxFrameBytes: 1048576 as const,
  confinementRequired: true as const,
};

test("FILETIME epoch 0 and fixture match runner unix_millis_to_rfc3339", () => {
  expect(unixMillisToRfc3339(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(filetimePartsToRfc3339(filetimeEpochParts())).toBe("1970-01-01T00:00:00.000Z");

  const oneSecondTicks = 116444736000000000n + 10_000_000n;
  expect(
    filetimePartsToRfc3339({
      dwLowDateTime: Number(oneSecondTicks & 0xffffffffn),
      dwHighDateTime: Number(oneSecondTicks >> 32n),
    }),
  ).toBe("1970-01-01T00:00:01.000Z");

  expect(unixMillisToRfc3339(1_704_067_200_000)).toBe("2024-01-01T00:00:00.000Z");
  const jan2024Ticks = 116444736000000000n + 1_704_067_200_000n * 10000n;
  expect(
    filetimePartsToRfc3339({
      dwLowDateTime: Number(jan2024Ticks & 0xffffffffn),
      dwHighDateTime: Number(jan2024Ticks >> 32n),
    }),
  ).toBe("2024-01-01T00:00:00.000Z");
  expect(unixMillisToRfc3339(Date.UTC(2024, 1, 29, 23, 59, 59, 999))).toBe(
    "2024-02-29T23:59:59.999Z",
  );
});

test("injected claim is sent and wall clock is not used", async () => {
  const transport = new QueueTransport([Buffer.from(canonicalizeRfc8785(HELLO), "utf8")]);
  const claim = {
    claimedProcessId: 99,
    claimedProcessCreationTime: "1970-01-01T00:00:00.000Z",
    clientInstanceId: newGeneralId("client_"),
  };
  await BrokerClient.connect(transport, claim);
  const helloSent = JSON.parse(Buffer.from(transport.sent[0] ?? []).toString("utf8")) as {
    claimedProcessCreationTime: string;
    claimedProcessId: number;
  };
  expect(helloSent.claimedProcessCreationTime).toBe("1970-01-01T00:00:00.000Z");
  expect(helloSent.claimedProcessId).toBe(99);
  expect(
    helloSent.claimedProcessCreationTime.includes(new Date().getUTCFullYear().toString()),
  ).toBe(false);
});

test("injected processClaim is used when connecting through the extension", async () => {
  const transport = new QueueTransport([Buffer.from(canonicalizeRfc8785(HELLO), "utf8")]);
  const pi = new FakePi();
  createHecExtension({
    transport,
    securityMode: "compatibility",
    processClaim: {
      claimedProcessId: 7,
      claimedProcessCreationTime: "1970-01-01T00:00:00.000Z",
      clientInstanceId: "client_injected",
    },
  })(pi);
  await pi.runCommand("init");
  const helloSent = JSON.parse(Buffer.from(transport.sent[0] ?? []).toString("utf8")) as {
    claimedProcessCreationTime: string;
  };
  expect(helloSent.claimedProcessCreationTime).toBe("1970-01-01T00:00:00.000Z");
});

test("GetProcessTimes failure is fail-closed and does not send wall clock", () => {
  expect(() => createProcessClaim(() => undefined)).toThrow("GetProcessTimes failed");
  const before = Date.now();
  try {
    createProcessClaim(() => undefined);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(new Date(before).toISOString());
  }
});

test("live GetProcessTimes FILETIME is memoized RFC3339", () => {
  const first = createProcessClaim();
  expect(first.claimedProcessCreationTime).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  );
  const second = createProcessClaim();
  expect(second.claimedProcessCreationTime).toBe(first.claimedProcessCreationTime);
  expect(first.claimedProcessId).toBe(process.pid);
});

test("unconfined node is not an AppContainer restricted token", () => {
  expect(readCurrentProcessIsAppContainer()).toBe(false);
  expect(defaultConfinementProbe()).toEqual({ confined: false });
});
