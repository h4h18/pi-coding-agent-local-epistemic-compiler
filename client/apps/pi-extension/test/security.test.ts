import { expect, test } from "vitest";
import { COMPATIBILITY_UNCONFINED, latestPointer } from "../src/session-pointer.js";
import { renderStatusLines } from "../src/ui/status-widget.js";
import { FakePi, RecordingBroker } from "./harness.js";

test("production path refuses unconfined enablement", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, {
    securityMode: "production",
    confinement: () => ({ confined: false }),
  });
  await pi.runCommand("mode on");
  expect(pi.notifications.some((line) => line.includes("refused"))).toBe(true);
  const result = await pi.emitInput("should not start");
  expect(result).toBeUndefined();
  expect(broker.methods()).toEqual([]);
  expect(pi.promptCalls).toBe(0);
});

test("compatibility path marks COMPATIBILITY_UNCONFINED and does not claim role isolation", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, {
    securityMode: "compatibility",
    confinement: () => ({ confined: false }),
  });
  await pi.runCommand("mode on");
  const pointer = latestPointer(pi.entries);
  expect(pointer?.uiPreferences.confinementMark).toBe(COMPATIBILITY_UNCONFINED);
  expect(pointer?.uiPreferences.roleIsolationClaimed).toBe(false);
  expect(pi.notifications.some((line) => line.includes(COMPATIBILITY_UNCONFINED))).toBe(true);
  if (pointer !== undefined) {
    expect(renderStatusLines(pointer, undefined)).toContain(COMPATIBILITY_UNCONFINED);
  }
});

test("session_shutdown closes the broker port for quit|reload|new|resume|fork", async () => {
  const reasons = ["quit", "reload", "new", "resume", "fork"] as const;
  for (const reason of reasons) {
    const broker = new RecordingBroker();
    const pi = new FakePi();
    pi.install(broker, { securityMode: "compatibility" });
    await pi.emit("session_shutdown", { type: "session_shutdown", reason });
    expect(broker.closed).toBe(true);
  }
});

test("HEC mode blocks user_bash without local exec", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand("mode on");
  const result = await pi.emit("user_bash", {
    type: "user_bash",
    command: "rm -rf /",
    excludeFromContext: false,
    cwd: pi.cwd,
  });
  expect(result).toEqual({
    result: {
      output: "HEC mode blocks local shell execution",
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  expect((result as { result?: { exitCode?: number } }).result?.exitCode).not.toBe(0);
  expect(broker.methods()).toEqual([]);
});

test("HEC mode blocks ordinary tool_call with terminate", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand("mode on");
  const result = await pi.emit("tool_call", {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    input: { command: "echo hi" },
  });
  expect(result).toEqual({
    block: true,
    terminate: true,
    reason: "HEC mode blocks ordinary Pi tools",
  });
});
