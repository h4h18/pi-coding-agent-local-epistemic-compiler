import { expect, test } from "vitest";
import { APPROVAL_PREVIEW_BANNER } from "../src/ui/approvals.js";
import { DIGEST, FakePi, RecordingBroker, RUN_ID, sampleRun } from "./harness.js";

function approvalBroker(): RecordingBroker {
  return new RecordingBroker(
    sampleRun({
      artifactRoles: [
        {
          role: "approval-subject",
          cardinality: "ONE_OR_MORE",
          objectDigests: [DIGEST],
        },
        {
          role: "verdict-report",
          cardinality: "ZERO_OR_ONE",
          objectDigests: [DIGEST],
        },
      ],
    }),
  );
}

test("approve and apply invoke OPEN_APPROVAL only and mint no grant", async () => {
  const broker = approvalBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });

  await pi.runCommand(`approve ${RUN_ID} cloud-egress`);
  expect(broker.methods()).toEqual(["GET_RUN_STATUS", "OPEN_APPROVAL"]);
  const approve = broker.calls[1];
  expect(approve?.method).toBe("OPEN_APPROVAL");
  if (approve?.method === "OPEN_APPROVAL") {
    expect(approve.params.action).toBe("cloud-egress");
    expect(approve.params.subjectObjectDigest).toBe(DIGEST);
    expect(approve.params.runId).toBe(RUN_ID);
  }
  expect(pi.notifications.some((line) => line.includes(APPROVAL_PREVIEW_BANNER))).toBe(true);

  broker.calls.length = 0;
  await pi.runCommand(`apply ${RUN_ID}`);
  expect(broker.methods()).toEqual(["GET_RUN_STATUS", "OPEN_APPROVAL"]);
  const apply = broker.calls[1];
  expect(apply?.method).toBe("OPEN_APPROVAL");
  if (apply?.method === "OPEN_APPROVAL") {
    expect(apply.params.action).toBe("workspace-promotion");
  }
  expect(broker.methods().includes("PROVIDE_INPUT")).toBe(false);
});

test("reject opens trusted approval UI and does not mutate artifacts", async () => {
  const broker = approvalBroker();
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });
  await pi.runCommand(`reject ${RUN_ID} not this change`);
  expect(broker.methods()).toEqual(["GET_RUN_STATUS", "OPEN_APPROVAL"]);
});
