import { expect, test } from "vitest";
import { compileCloudContext } from "../src/index.js";
import { compilerInput } from "./fixtures.js";

test("same compiler inputs produce the same ContextPacket payload digest", () => {
  const input = compilerInput();
  const first = compileCloudContext(input);
  const second = compileCloudContext(input);
  expect(first.kind).toBe("compiled");
  expect(second.kind).toBe("compiled");
  if (first.kind !== "compiled" || second.kind !== "compiled") {
    return;
  }
  expect(first.artifacts.packetEnvelope.payloadDigest).toBe(second.artifacts.packetEnvelope.payloadDigest);
  expect(first.artifacts.packetEnvelope.payloadDigest.startsWith("sha256:")).toBe(true);
});

test("fixed signer fixture produces the same envelope object digest", () => {
  const input = compilerInput();
  const first = compileCloudContext(input);
  const second = compileCloudContext(input);
  expect(first.kind).toBe("compiled");
  expect(second.kind).toBe("compiled");
  if (first.kind !== "compiled" || second.kind !== "compiled") {
    return;
  }
  expect(first.artifacts.packetEnvelope.signatures[0]?.keyId).toBe("control-test-1");
  expect(first.artifacts.canonicalEnvelope.signatures[0]?.signedAt).toBe(
    second.artifacts.canonicalEnvelope.signatures[0]?.signedAt,
  );
  const left = first.artifacts.packetEnvelope;
  const right = second.artifacts.packetEnvelope;
  expect(JSON.stringify(left)).toBe(JSON.stringify(right));
});
