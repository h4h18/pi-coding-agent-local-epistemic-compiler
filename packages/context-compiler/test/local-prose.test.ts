import { canonicalizeRfc8785 } from "@pi-hec/contracts";
import { expect, test } from "vitest";
import { compileCloudContext } from "../src/index.js";
import { INJECTION, buildWorld, compilerInput } from "./fixtures.js";

test("local-model prose and prompt-injection never appear in packet, conversation, or egress", () => {
  const world = buildWorld({ includeInjection: true });
  const outcome = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const packet = canonicalizeRfc8785(outcome.artifacts.packet);
  const conversation = canonicalizeRfc8785(outcome.artifacts.conversation);
  const egress = canonicalizeRfc8785(outcome.artifacts.egress);
  expect(packet.includes(INJECTION)).toBe(false);
  expect(conversation.includes(INJECTION)).toBe(false);
  expect(egress.includes(INJECTION)).toBe(false);
  expect(
    outcome.artifacts.packet.evidencePayloads.some(
      (item) => item.node.authorship === "LOCAL_MODEL",
    ),
  ).toBe(false);
});
