import { expect, test } from "vitest";
import { COMPATIBILITY_UNCONFINED, latestPointer } from "../src/session-pointer.js";
import { FakePi, RecordingBroker, RUN_ID, TS } from "./harness.js";

test("pointer round-trip restores the same run id and re-GET_RUN_STATUS", async () => {
  const broker = new RecordingBroker();
  const first = new FakePi();
  first.install(broker, { securityMode: "compatibility", controlEndpointIdentity: "endpoint-a" });
  await first.runCommand("mode on");
  await first.emitInput("continue the work");
  expect(broker.methods()).toContain("START_RUN");

  const restored = new FakePi();
  restored.entries.push(...first.entries);
  const restoreBroker = new RecordingBroker();
  restored.install(restoreBroker, {
    securityMode: "compatibility",
    controlEndpointIdentity: "endpoint-a",
  });
  await restored.emit("session_start", { type: "session_start", reason: "startup" });

  expect(restoreBroker.methods()).toContain("GET_RUN_STATUS");
  const status = restoreBroker.calls.find((call) => call.method === "GET_RUN_STATUS");
  expect(status?.method).toBe("GET_RUN_STATUS");
  if (status?.method === "GET_RUN_STATUS") {
    expect(status.params.runId).toBe(RUN_ID);
  }
  expect(restoreBroker.methods()).toContain("POLL_RUN_EVENTS");

  const forked = new FakePi();
  forked.entries.push(...first.entries);
  const forkBroker = new RecordingBroker();
  forked.install(forkBroker, { securityMode: "compatibility" });
  await forked.emit("session_start", { type: "session_start", reason: "fork" });
  expect(forkBroker.calls[0]).toMatchObject({ method: "GET_RUN_STATUS", params: { runId: RUN_ID } });

  const reloaded = new FakePi();
  reloaded.entries.push(...first.entries);
  const reloadBroker = new RecordingBroker();
  reloaded.install(reloadBroker, { securityMode: "compatibility" });
  await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
  expect(reloadBroker.calls[0]).toMatchObject({ method: "GET_RUN_STATUS", params: { runId: RUN_ID } });
});

test("restore cannot claim isolation from transcript bytes", async () => {
  const first = new FakePi();
  first.appendEntry("hec-run-pointer", {
    activeRunId: null,
    controlEndpointIdentity: "endpoint-a",
    lastDisplayedEventSequence: 0,
    uiPreferences: {
      hecModeEnabled: true,
      securityMode: "production",
      roleIsolationClaimed: true,
      confinementMark: null,
      workspaceAlias: "demo-workspace",
    },
  });
  first.install(new RecordingBroker(), {
    securityMode: "compatibility",
    confinement: () => ({ confined: false }),
  });
  await first.emit("session_start", { type: "session_start", reason: "startup" });
  const pointer = latestPointer(first.entries);
  expect(pointer?.uiPreferences.roleIsolationClaimed).toBe(false);
  expect(pointer?.uiPreferences.confinementMark).toBe(COMPATIBILITY_UNCONFINED);
  expect(pointer?.uiPreferences.securityMode).toBe("compatibility");
});

test("polling 200 events does not silently watermark lastDisplayedEventSequence", async () => {
  const first = new FakePi();
  first.install(new RecordingBroker(), { securityMode: "compatibility" });
  await first.runCommand("mode on");
  await first.emitInput("keep going");
  const pointer = latestPointer(first.entries);
  expect(pointer?.lastDisplayedEventSequence).toBe(0);

  const restoreBroker = new RecordingBroker();
  restoreBroker.pollEvents = {
    requestId: "ignored",
    outcome: "EVENTS",
    page: {
      schemaVersion: 1,
      events: Array.from({ length: 200 }, (_, index) => ({
        schemaVersion: 1 as const,
        eventId: `evt_${String(index + 1)}`,
        eventType: "ENTER_CREATED" as const,
        projectId: "proj1",
        runId: RUN_ID,
        sequence: index + 1,
        previousState: "CREATED" as const,
        nextState: "CREATED" as const,
        actorType: "user" as const,
        actorId: "actor_1",
        inputArtifactObjectDigests: [],
        outputArtifactObjectDigests: [],
        reasonCode: "reason_poll",
        occurredAt: TS,
      })),
      nextAfter: null,
    },
  };
  const restored = new FakePi();
  restored.entries.push(...first.entries);
  restored.install(restoreBroker, { securityMode: "compatibility" });
  await restored.emit("session_start", { type: "session_start", reason: "startup" });
  expect(restoreBroker.methods()).toContain("POLL_RUN_EVENTS");
  expect(latestPointer(restored.entries)?.lastDisplayedEventSequence).toBe(0);
});
