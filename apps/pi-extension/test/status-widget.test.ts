import { expect, test } from "vitest";
import { latestPointer } from "../src/session-pointer.js";
import { createStatusEntryRenderer, renderStatusLines } from "../src/ui/status-widget.js";
import { FakePi, RecordingBroker, RUN_ID, SNAP_ID, sampleRun } from "./harness.js";

test("status widget shows run state and snapshotId from lastRun", async () => {
  const broker = new RecordingBroker(
    sampleRun({
      state: "SUCCEEDED",
      snapshotId: SNAP_ID,
    }),
  );
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand(`status ${RUN_ID}`);
  const pointer = latestPointer(pi.entries);
  expect(pointer).toBeDefined();
  if (pointer === undefined) {
    return;
  }
  const lines = renderStatusLines(pointer, broker.run);
  expect(lines.some((line) => line.includes("SUCCEEDED"))).toBe(true);
  expect(lines.some((line) => line.includes(SNAP_ID))).toBe(true);
  expect(lines.some((line) => /Preflight:\s*\d/u.test(line))).toBe(false);
  expect(lines.some((line) => /Cloud:\s*\d/u.test(line))).toBe(false);
  expect(lines.some((line) => /Usage:\s*\d/u.test(line))).toBe(false);
  expect(lines.some((line) => /Verdict:\s*\d/u.test(line))).toBe(false);
});

test("createStatusEntryRenderer reads HecRuntime.lastRun and omits missing snapshotId", () => {
  const run = sampleRun({ state: "CREATED" });
  const renderer = createStatusEntryRenderer(() => run);
  const pointer = {
    activeRunId: RUN_ID,
    controlEndpointIdentity: "endpoint-a",
    lastDisplayedEventSequence: 0,
    uiPreferences: {
      hecModeEnabled: true,
      securityMode: "compatibility" as const,
      roleIsolationClaimed: false,
      confinementMark: null,
      workspaceAlias: "demo",
    },
  };
  const lines = renderStatusLines(pointer, run);
  expect(lines).toContain(`state CREATED`);
  expect(lines.some((line) => line.startsWith("snapshot "))).toBe(false);
  expect(typeof renderer).toBe("function");
});
