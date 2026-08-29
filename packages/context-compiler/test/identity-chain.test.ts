import { canonicalizeRfc8785, taggedHash } from "@pi-hec/contracts";
import { expect, test } from "vitest";
import { compileCloudContext, envelopeDigestOf, toJsonValue } from "../src/index.js";
import { compilerInput } from "./fixtures.js";

test("identity chain is acyclic: binding → conversation → egress → canonical", () => {
  const outcome = compileCloudContext(compilerInput());
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const { artifacts } = outcome;
  const expectedBinding = taggedHash("cloud-request-binding", 1, {
    requestBinding: toJsonValue(artifacts.requestBinding),
  });
  expect(artifacts.requestBindingDigest).toBe(expectedBinding);
  expect(artifacts.conversation.requestBindingDigest).toBe(expectedBinding);
  expect(canonicalizeRfc8785(artifacts.conversation.requestBinding)).toBe(
    canonicalizeRfc8785(artifacts.canonical.requestBinding),
  );
  expect(artifacts.egress.compiledConversationObjectDigest).toBe(envelopeDigestOf(artifacts.conversationEnvelope));
  expect(artifacts.canonical.egressManifestObjectDigest).toBe(envelopeDigestOf(artifacts.egressEnvelope));
  expect(artifacts.canonical.compiledConversationObjectDigest).toBe(
    envelopeDigestOf(artifacts.conversationEnvelope),
  );
  expect(artifacts.canonical.contextPacketObjectDigest).toBe(envelopeDigestOf(artifacts.packetEnvelope));
  const bindingJson = canonicalizeRfc8785({ requestBinding: artifacts.requestBinding });
  expect(bindingJson.includes(artifacts.egress.compiledConversationObjectDigest)).toBe(false);
  expect(bindingJson.includes(artifacts.canonical.egressManifestObjectDigest)).toBe(false);
  expect(JSON.stringify(artifacts.requestBinding).includes("compiledConversationObjectDigest")).toBe(false);
  expect(JSON.stringify(artifacts.requestBinding).includes("egressManifestObjectDigest")).toBe(false);
});
