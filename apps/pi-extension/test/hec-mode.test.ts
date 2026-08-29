import { expect, test } from "vitest";
import { FakePi, RecordingBroker, RUN_ID } from "./harness.js";

test("/hec mode on then typed input returns handled and START_RUN without prompt", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });

  await pi.runCommand("mode on");
  const result = await pi.emitInput("fix the failing test");

  expect(result).toEqual({ action: "handled" });
  expect(broker.methods()).toContain("START_RUN");
  const start = broker.calls.find((call) => call.method === "START_RUN");
  expect(start?.method).toBe("START_RUN");
  if (start?.method === "START_RUN") {
    expect(start.params.originalRequest).toBe("fix the failing test");
    expect(start.params.attachmentHandles).toEqual([]);
    expect(start.params.workspaceAlias).toBe("demo-workspace");
  }
  expect(pi.promptCalls).toBe(0);
  expect(pi.entries.some((entry) => entry.customType === "hec-run-pointer")).toBe(true);
  expect(pi.entries.at(-1)?.data).toMatchObject({ activeRunId: RUN_ID });
});

test("/hec task starts a run without invoking the cloud loop", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand("task repair the baseline");
  expect(broker.methods()).toEqual(["START_RUN"]);
  expect(pi.promptCalls).toBe(0);
});
