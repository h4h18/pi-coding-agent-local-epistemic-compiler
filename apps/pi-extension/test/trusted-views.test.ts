import { expect, test } from "vitest";
import { isTrustedView, TRUSTED_VIEWS } from "../src/broker-client.js";
import { FakePi, RecordingBroker, RUN_ID } from "./harness.js";

test("trusted views use only allowed view enums", async () => {
  const broker = new RecordingBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });

  await pi.runCommand(`context ${RUN_ID}`);
  await pi.runCommand(`diff ${RUN_ID}`);
  await pi.runCommand(`verify ${RUN_ID}`);
  await pi.runCommand(`inspect ${RUN_ID}`);
  await pi.runCommand(`export ${RUN_ID}`);

  const views = broker.calls.flatMap((call) => (call.method === "OPEN_TRUSTED_VIEW" ? [call.params.view] : []));
  expect(views).toEqual(["CONTEXT", "DIFF", "VERIFICATION", "ARTIFACTS", "EXPORT"]);
  for (const view of views) {
    expect(isTrustedView(view)).toBe(true);
  }
});

test("unknown view is never sent", () => {
  expect(isTrustedView("SECRETS")).toBe(false);
  expect(isTrustedView("RAW")).toBe(false);
  expect(isTrustedView("CONTEXT")).toBe(true);
  expect(TRUSTED_VIEWS.includes("CONTEXT")).toBe(true);
});
