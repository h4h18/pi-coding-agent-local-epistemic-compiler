import { expect, test } from "vitest";
import { CACHE_PREFIX_ORDER, compileCloudContext } from "../src/index.js";
import { CALL, PROJECT, compilerInput } from "./fixtures.js";

test("cache prefix order is stable and omits runId", () => {
  const first = compileCloudContext(compilerInput());
  const second = compileCloudContext(
    compilerInput({
      cloudCallId: "call_01234567-89ab-7cde-8f01-23456789abce",
    }),
  );
  expect(first.kind).toBe("compiled");
  expect(second.kind).toBe("compiled");
  if (first.kind !== "compiled" || second.kind !== "compiled") {
    return;
  }
  let cursor = 0;
  for (const part of CACHE_PREFIX_ORDER) {
    const token = `<<${part}>>`;
    const index = first.artifacts.cachePrefix.indexOf(token);
    expect(index).toBeGreaterThanOrEqual(cursor);
    cursor = index;
  }
  expect(first.artifacts.cachePrefix.includes(first.artifacts.packet.runId)).toBe(false);
  expect(second.artifacts.cachePrefix.includes(second.artifacts.packet.runId)).toBe(false);
  expect(first.artifacts.cachePrefix).toBe(second.artifacts.cachePrefix);
  expect(CALL.startsWith("call_")).toBe(true);
});

test("cross-project cache identity differs", () => {
  const left = compileCloudContext(compilerInput({ projectId: PROJECT }));
  const right = compileCloudContext(compilerInput({ projectId: "proj-other" }));
  expect(left.kind).toBe("compiled");
  expect(right.kind).toBe("compiled");
  if (left.kind !== "compiled" || right.kind !== "compiled") {
    return;
  }
  expect(left.artifacts.cacheIdentity).not.toBe(right.artifacts.cacheIdentity);
});

test("cache identity includes inline content digests not only evidence ids", () => {
  const input = compilerInput();
  const first = compileCloudContext(input);
  const payloads = input.payloads.map((payload) => {
    const source = payload.sources[0];
    if (source.content.encoding !== "utf-8") {
      return payload;
    }
    if (source.sourceRef.origin !== "repository" || source.sourceRef.path !== "src/parse.ts") {
      return payload;
    }
    return {
      ...payload,
      sources: [
        { ...source, content: { encoding: "utf-8" as const, text: `${source.content.text}\n// cache-identity` } },
        ...payload.sources.slice(1),
      ],
    };
  });
  const second = compileCloudContext({ ...input, payloads });
  expect(first.kind).toBe("compiled");
  expect(second.kind).toBe("compiled");
  if (first.kind !== "compiled" || second.kind !== "compiled") {
    return;
  }
  const firstIds = first.artifacts.packet.evidencePayloads.map((item) => item.evidenceId).join("\n");
  const secondIds = second.artifacts.packet.evidencePayloads.map((item) => item.evidenceId).join("\n");
  expect(firstIds).toBe(secondIds);
  expect(first.artifacts.cacheIdentity).not.toBe(second.artifacts.cacheIdentity);
});
