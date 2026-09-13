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

test("/hec <задача> is the same as /hec task <задача>", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand("исправь failing test, не трогая generated file");
  expect(broker.methods()).toEqual(["START_RUN"]);
  const start = broker.calls.find((call) => call.method === "START_RUN");
  expect(start?.method).toBe("START_RUN");
  if (start?.method === "START_RUN") {
    expect(start.params.originalRequest).toBe(
      "исправь failing test, не трогая generated file",
    );
  }
});

test("/hec agents lists run agents from the broker", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand(`agents ${RUN_ID}`);
  expect(broker.methods()).toContain("LIST_AGENTS");
  expect(pi.notifications.some((line) => line.includes("HEC agents"))).toBe(true);
});

test("/hec answer provides input and /hec recover resumes then lists agents", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand(`answer ${RUN_ID} use the overlay`);
  expect(broker.methods()).toContain("GET_RUN_STATUS");
  expect(broker.methods()).toContain("PROVIDE_INPUT");
  await pi.runCommand(`recover ${RUN_ID}`);
  expect(broker.methods()).toContain("RESUME_RUN");
  expect(broker.methods()).toContain("LIST_AGENTS");
});
