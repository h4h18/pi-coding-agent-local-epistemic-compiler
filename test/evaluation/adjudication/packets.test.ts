import { expect, test } from "vitest";
import { adjudicate, sensitivityExcludingSymmetricUndetermined } from "./rules.js";
import {
  aggregateBallots,
  agreementRate,
  blindedPacketLeaks,
  buildBlindedPacket,
} from "./packets.js";

test("blinded adjudication packet has no arm model verdict or gold identity and aggregates two raters plus tie-break", () => {
  const packet = buildBlindedPacket({
    packetId: "pkt-1",
    taskId: "eval-polyglot-001",
    anonymizedDiff: "diff",
    evidence: ["hidden-tests"],
    mustRequirements: ["MUST keep generated files"],
  });
  expect(blindedPacketLeaks(packet)).toEqual([]);
  expect(JSON.stringify(packet)).not.toMatch(/arm|model|verdict|gold/i);
  const agreed = aggregateBallots({
    first: { raterId: "a", packetId: "pkt-1", label: "CORRECT" },
    second: { raterId: "b", packetId: "pkt-1", label: "CORRECT" },
  });
  expect(agreed).toEqual({ label: "CORRECT", agreement: true, tieBroken: false });
  const tied = aggregateBallots({
    first: { raterId: "a", packetId: "pkt-1", label: "CORRECT" },
    second: { raterId: "b", packetId: "pkt-1", label: "INCORRECT" },
    tieBreaker: { raterId: "c", packetId: "pkt-1", label: "UNDETERMINED" },
  });
  expect(tied).toEqual({ label: "UNDETERMINED", agreement: false, tieBroken: true });
  expect(agreementRate([agreed, tied])).toBe(0.5);
});

test("adjudication rules treat style-only as non-failing and undetermined as primary failure for both arms", () => {
  expect(
    adjudicate({
      external: "CORRECT",
      localVerdict: "ACCEPTED",
      styleOnlyMismatch: true,
      securityBreach: false,
      secretEgress: false,
      outOfScopeWrite: false,
      hiddenTestAccess: false,
    }).primaryFailure,
  ).toBe(false);
  const falseVerified = adjudicate({
    external: "INCORRECT",
    localVerdict: "ACCEPTED",
    styleOnlyMismatch: false,
    securityBreach: false,
    secretEgress: false,
    outOfScopeWrite: false,
    hiddenTestAccess: false,
  });
  expect(falseVerified.falseVerification).toBe(true);
  const harm = adjudicate({
    external: "CORRECT",
    localVerdict: "REJECTED",
    styleOnlyMismatch: false,
    securityBreach: false,
    secretEgress: false,
    outOfScopeWrite: false,
    hiddenTestAccess: false,
  });
  expect(harm.verifierInducedHarm).toBe(true);
  expect(harm.primaryFailure).toBe(true);
  const undetermined = adjudicate({
    external: "UNDETERMINED",
    localVerdict: "INCONCLUSIVE",
    styleOnlyMismatch: false,
    securityBreach: false,
    secretEgress: false,
    outOfScopeWrite: false,
    hiddenTestAccess: false,
  });
  expect(undetermined.label).toBe("UNDETERMINED");
  expect(undetermined.primaryFailure).toBe(true);
  const noOracle = adjudicate({
    external: "CORRECT",
    localVerdict: "ACCEPTED",
    styleOnlyMismatch: false,
    securityBreach: false,
    secretEgress: false,
    outOfScopeWrite: false,
    hiddenTestAccess: false,
    noOracle: true,
  });
  expect(noOracle.label).toBe("UNDETERMINED");
  expect(noOracle.primaryFailure).toBe(true);
  expect(
    sensitivityExcludingSymmetricUndetermined([
      { baseline: "UNDETERMINED", hec: "UNDETERMINED" },
      { baseline: "CORRECT", hec: "INCORRECT" },
    ]),
  ).toEqual([{ baseline: "CORRECT", hec: "INCORRECT" }]);
});
