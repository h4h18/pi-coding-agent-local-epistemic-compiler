import { expect, test } from "vitest";
import { claimProductionGoLive, evaluateSection33Gates, SECTION33_GATE_IDS } from "./section33.js";

test("production go-live claim passes every section 33 gate", async () => {
  const decision = await claimProductionGoLive({
    hourlyEpoch: "epoch-ab",
    terminalEpoch: "epoch-cd",
  });
  expect(decision.gates.map((gate) => gate.id)).toEqual([...SECTION33_GATE_IDS]);
  expect(decision.gates.filter((gate) => !gate.passed)).toEqual([]);
  expect(decision.section33GatesClaimed).toBe(true);
});

test("backup gates stay unclaimed without epoch proof", async () => {
  const decision = await evaluateSection33Gates();
  expect(decision.gates.find((gate) => gate.id === "backup-hourly")?.passed).toBe(false);
  expect(decision.gates.find((gate) => gate.id === "backup-on-terminal")?.passed).toBe(false);
  expect(decision.gates.find((gate) => gate.id === "no-placeholders")?.passed).toBe(false);
  expect(decision.section33GatesClaimed).toBe(false);
});
