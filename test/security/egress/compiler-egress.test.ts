import { canonicalizeRfc8785, sha256Hex } from "@pi-hec/contracts";
import { expect, test } from "vitest";
import {
  compileCloudContext,
  type InlinePayload,
} from "../../../packages/context-compiler/src/index.js";
import {
  AGENTS_BODY,
  AWS_CANARY,
  CARD_CANARY,
  EMAIL_LITERAL,
  PEM_CANARY,
  SSN_CANARY,
  buildWorld,
  compilerInput,
  deployment,
  instructionManifest,
} from "../../../packages/context-compiler/test/fixtures.js";

function leaked(haystack: string, canary: string): boolean {
  return haystack.includes(canary);
}

test("restricted canaries never appear in cloud bytes and block egress", () => {
  for (const canary of [AWS_CANARY, SSN_CANARY, CARD_CANARY, PEM_CANARY] as const) {
    const world = buildWorld({ secretInSource: canary === AWS_CANARY });
    const payloads =
      canary === AWS_CANARY
        ? world.payloads
        : world.payloads.map((payload, index): InlinePayload => {
            if (index !== 1) {
              return payload;
            }
            const [source, ...rest] = payload.sources;
            if (source.content.encoding !== "utf-8") {
              return payload;
            }
            const text = `${source.content.text}\n${canary}`;
            return {
              ...payload,
              sources: [{ ...source, content: { encoding: "utf-8" as const, text } }, ...rest],
            };
          });
    const outcome = compileCloudContext(
      compilerInput({
        graph: world.graph,
        bundles: world.bundles,
        payloads,
      }),
    );
    expect(outcome.kind).toBe("waiting");
    if (outcome.kind !== "waiting") {
      return;
    }
    expect(outcome.state).toBe("WAITING_CLOUD_ELIGIBILITY");
    expect(leaked(JSON.stringify(outcome), canary)).toBe(false);
  }
});

test("permitted email redaction is stable and patch-on-redacted is rejected", () => {
  const world = buildWorld({ emailInSource: true });
  const compiled = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
    }),
  );
  expect(compiled.kind).toBe("compiled");
  if (compiled.kind !== "compiled") {
    return;
  }
  const conversation = canonicalizeRfc8785(compiled.artifacts.conversation);
  expect(conversation.includes(EMAIL_LITERAL)).toBe(false);
  const again = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
    }),
  );
  expect(again.kind).toBe("compiled");
  if (again.kind !== "compiled") {
    return;
  }
  expect(canonicalizeRfc8785(again.artifacts.conversation)).toBe(conversation);
  const rejected = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
      intendedPatchPaths: ["src/parse.ts"],
    }),
  );
  expect(rejected.kind).toBe("failed");
  if (rejected.kind !== "failed") {
    return;
  }
  expect(rejected.code).toBe("PATCH_DEPENDS_ON_REDACTED");
});

test("restricted canaries resume on a no-egress private executor", () => {
  const world = buildWorld({ secretInSource: true });
  const outcome = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
      noEgressCloudRoleAvailable: true,
      deployment: deployment({
        endpointIdentity: "https://executor.internal.test/v1",
        providerChain: ["private-no-egress"],
      }),
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  expect(outcome.artifacts.egress.classification).not.toBe("restricted");
  expect(outcome.artifacts.egress.providerChain).toEqual(["private-no-egress"]);
  expect(outcome.artifacts.egress.endpointIdentity).toBe("https://executor.internal.test/v1");
});

test("restricted canaries still wait when the no-egress flag points at a SaaS chain", () => {
  const world = buildWorld({ secretInSource: true });
  const outcome = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads: world.payloads,
      noEgressCloudRoleAvailable: true,
      deployment: deployment({
        endpointIdentity: "https://api.openai.com/v1",
        providerChain: ["openai"],
      }),
    }),
  );
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_CLOUD_ELIGIBILITY");
  expect(leaked(JSON.stringify(outcome), AWS_CANARY)).toBe(false);
});

test("single-source evidence payloads compile", () => {
  const world = buildWorld();
  const payloads = world.payloads.map((payload): InlinePayload => ({
    ...payload,
    sources: [payload.sources[0]],
  }));
  const outcome = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads,
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  expect(outcome.artifacts.packet.evidencePayloads.every((item) => item.sources.length >= 1)).toBe(
    true,
  );
});

test("AWS key only in a base64 source blocks egress", () => {
  const world = buildWorld();
  const payloads = world.payloads.map((payload, index): InlinePayload => {
    if (index !== 1) {
      return payload;
    }
    const [source] = payload.sources;
    return {
      ...payload,
      sources: [
        {
          ...source,
          content: {
            encoding: "base64" as const,
            base64: Buffer.from(`const key = "${AWS_CANARY}";`, "utf8").toString("base64"),
          },
        },
      ],
    };
  });
  const outcome = compileCloudContext(
    compilerInput({
      graph: world.graph,
      bundles: world.bundles,
      payloads,
    }),
  );
  expect(outcome.kind).toBe("waiting");
  if (outcome.kind !== "waiting") {
    return;
  }
  expect(outcome.state).toBe("WAITING_CLOUD_ELIGIBILITY");
  expect(leaked(JSON.stringify(outcome), AWS_CANARY)).toBe(false);
});

test("permitted email in an instruction is redacted and listed on the egress manifest", () => {
  const instructions = instructionManifest();
  const body = `${AGENTS_BODY}\ncontact ${EMAIL_LITERAL}`;
  const descriptor = instructions.manifest.instructions[0];
  const instructionBody = instructions.bodies[0];
  if (descriptor === undefined || instructionBody === undefined) {
    throw new Error("instruction fixture missing");
  }
  const outcome = compileCloudContext(
    compilerInput({
      instructionManifest: {
        ...instructions.manifest,
        instructions: [{ ...descriptor, contentDigest: sha256Hex(Buffer.from(body, "utf8")) }],
      },
      authoritativeInstructions: [{ ...instructionBody, verbatimContent: body }],
    }),
  );
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const conversation = canonicalizeRfc8785(outcome.artifacts.conversation);
  expect(conversation.includes(EMAIL_LITERAL)).toBe(false);
  expect(
    outcome.artifacts.egress.redactions.some(
      (item) => item.findingType === "email" && item.marker.includes("REDACTED"),
    ),
  ).toBe(true);
});

test("identity chain binding digest is independent of egress and conversation envelopes", () => {
  const outcome = compileCloudContext(compilerInput());
  expect(outcome.kind).toBe("compiled");
  if (outcome.kind !== "compiled") {
    return;
  }
  const binding = JSON.stringify(outcome.artifacts.requestBinding);
  expect(binding.includes(outcome.artifacts.egress.compiledConversationObjectDigest)).toBe(false);
  expect(binding.includes(outcome.artifacts.canonical.egressManifestObjectDigest)).toBe(false);
});
