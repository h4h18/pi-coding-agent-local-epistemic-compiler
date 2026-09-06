import { expect, test } from "vitest";
import type { RunTransitionEvent } from "@pi-hec/contracts";
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

function transitionEvents(count: number): RunTransitionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 1,
    eventId: `evt_${String(index + 1)}`,
    eventType: "ENTER_CREATED",
    projectId: "proj1",
    runId: RUN_ID,
    sequence: index + 1,
    previousState: "CREATED",
    nextState: "CREATED",
    actorType: "user",
    actorId: "actor_1",
    inputArtifactObjectDigests: [],
    outputArtifactObjectDigests: [],
    reasonCode: "reason_poll",
    occurredAt: TS,
  }));
}

async function startedSession(): Promise<FakePi> {
  const first = new FakePi();
  first.install(new RecordingBroker(), { securityMode: "compatibility" });
  await first.runCommand("mode on");
  await first.emitInput("keep going");
  expect(latestPointer(first.entries)?.lastDisplayedEventSequence).toBe(0);
  return first;
}

test("lastDisplayedEventSequence advances only to the highest event actually rendered", async () => {
  const first = await startedSession();

  const restoreBroker = new RecordingBroker();
  restoreBroker.pollEvents = {
    requestId: "ignored",
    outcome: "EVENTS",
    page: { schemaVersion: 1, events: transitionEvents(200), nextAfter: null },
  };
  const restored = new FakePi();
  restored.entries.push(...first.entries);
  restored.install(restoreBroker, { securityMode: "compatibility" });
  await restored.emit("session_start", { type: "session_start", reason: "startup" });

  const poll = restoreBroker.calls.find((call) => call.method === "POLL_RUN_EVENTS");
  expect(poll?.method).toBe("POLL_RUN_EVENTS");
  if (poll?.method === "POLL_RUN_EVENTS") {
    expect(poll.params.afterSequence).toBe(0);
  }
  const rendered = restored.notifications.filter((line) => line.includes("(reason_poll)"));
  expect(rendered).toHaveLength(200);
  expect(rendered[0]).toBe("#1 CREATED -> CREATED (reason_poll)");
  expect(rendered[199]).toBe("#200 CREATED -> CREATED (reason_poll)");
  expect(latestPointer(restored.entries)?.lastDisplayedEventSequence).toBe(200);
});

test("an empty event page never moves lastDisplayedEventSequence", async () => {
  const first = await startedSession();

  const restored = new FakePi();
  restored.entries.push(...first.entries);
  restored.install(new RecordingBroker(), { securityMode: "compatibility" });
  await restored.emit("session_start", { type: "session_start", reason: "startup" });

  expect(restored.notifications.some((line) => line.includes("(reason_poll)"))).toBe(false);
  expect(latestPointer(restored.entries)?.lastDisplayedEventSequence).toBe(0);
});
