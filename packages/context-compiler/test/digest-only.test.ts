import { expect, test } from "vitest";
import { compileCloudContext, type InlinePayload } from "../src/index.js";
import { compilerInput, digestOf } from "./fixtures.js";

test("digest-only evidence bodies fail compilation", () => {
  const input = compilerInput();
  const digestOnly = input.payloads.map((payload, index): InlinePayload => {
    if (index !== 1) {
      return payload;
    }
    const [source, ...rest] = payload.sources;
    const digest = payload.node.contentObjectDigest ?? digestOf("missing");
    return {
      ...payload,
      sources: [{ ...source, content: { encoding: "utf-8" as const, text: digest } }, ...rest],
    };
  });
  const outcome = compileCloudContext({ ...input, payloads: digestOnly });
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.code).toBe("DIGEST_ONLY");
});

test("digest-only mandatory skill bodies fail compilation", () => {
  const input = compilerInput();
  const loaded = input.loadedSkills.map((skill) => ({
    ...skill,
    verbatimContent: skill.descriptor.contentDigest,
  }));
  const outcome = compileCloudContext({ ...input, loadedSkills: loaded });
  expect(outcome.kind).toBe("failed");
  if (outcome.kind !== "failed") {
    return;
  }
  expect(outcome.code === "DIGEST_ONLY" || outcome.code === "CLOSURE").toBe(true);
});
