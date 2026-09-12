import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import { CloudDispatchSchema, ContextPacketSchema } from "@pi-hec/contracts";
import { AgentSession, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createOneShotAdapter } from "@pi-hec/cloud-gateway";
import {
  runOrdinaryPiBaseline,
  ORDINARY_PI_PACKAGE,
  ORDINARY_PI_VERSION,
  type BaselineSession,
} from "./baseline-runner.js";
import {
  buildHecPacket,
  hecPacketHasEvaluationHints,
  runHecArm,
  HEC_CLOUD_EXECUTOR,
} from "./hec-runner.js";

const PACKET = Compile(ContextPacketSchema);
const DISPATCH = Compile(CloudDispatchSchema);

const HEC_SOURCE = readFileSync(fileURLToPath(new URL("./hec-runner.ts", import.meta.url)), "utf8");
const PI_PACKAGE = JSON.parse(
  readFileSync(
    path.join(
      fileURLToPath(
        new URL(
          "../../../client/apps/pi-extension/node_modules/@earendil-works/pi-coding-agent/package.json",
          import.meta.url,
        ),
      ),
    ),
    "utf8",
  ),
) as { version: string };

test("ordinary Pi baseline runner uses pi-coding-agent 0.84.3 prompt API", async () => {
  expect(ORDINARY_PI_PACKAGE).toBe("@earendil-works/pi-coding-agent");
  expect(ORDINARY_PI_VERSION).toBe("0.84.3");
  expect(PI_PACKAGE.version).toBe("0.84.3");
  expect(typeof createAgentSession).toBe("function");
  expect(typeof AgentSession.prototype.prompt).toBe("function");
  let prompted = 0;
  const session: BaselineSession = {
    prompt: () => {
      prompted += 1;
      return Promise.resolve();
    },
    subscribe: (listener: (event: { type: string }) => void) => {
      listener({ type: "message_end" });
      listener({ type: "message_end" });
      listener({ type: "turn_end" });
      return () => undefined;
    },
    getSessionStats: () => ({ assistantMessages: 1 }),
    messages: [{ role: "assistant" }, { role: "assistant" }, { role: "assistant" }],
  };
  const result = await runOrdinaryPiBaseline({
    cwd: process.cwd(),
    prompt: "fix the failing test",
    createSession: () => Promise.resolve({ session }),
  });
  expect(prompted).toBe(1);
  expect(result.promptTurns).toBe(1);
  expect(result.stoppedNaturally).toBe(true);
  expect(result.tools).toEqual(["read", "bash", "edit", "write"]);
});

test("HEC arm uses production one-shot and a ContextPacketSchema packet", async () => {
  expect(HEC_CLOUD_EXECUTOR).toBe("createOneShotAdapter.completeOnce");
  expect(typeof createOneShotAdapter).toBe("function");
  expect(HEC_SOURCE.includes("createOneShotAdapter")).toBe(true);
  expect(HEC_SOURCE.includes("AgentSession")).toBe(false);
  expect(HEC_SOURCE.includes(".prompt(")).toBe(false);
  expect(HEC_SOURCE.includes("createAgentSession")).toBe(false);
  const packet = buildHecPacket("Fix the failing test. Do not modify generated files.");
  expect(PACKET.Check(packet)).toBe(true);
  expect(hecPacketHasEvaluationHints(packet)).toBe(false);
  let seen: unknown;
  const result = await runHecArm({
    phase: "first",
    prompt: "Fix the failing test. Do not modify generated files.",
    completeOnce: (dispatch) => {
      seen = dispatch;
      return Promise.resolve({ state: "completed" });
    },
  });
  expect(DISPATCH.Check(seen)).toBe(true);
  expect(seen !== null && typeof seen === "object").toBe(true);
  expect(Object.keys(seen as object).sort()).toEqual([
    "conversation",
    "egress",
    "request",
    "wireRequest",
  ]);
  expect(result.state).toBe("completed");
  expect(result.phase).toBe("first");
  expect(result.packet).toEqual(packet);
  expect(PACKET.Check(result.packet)).toBe(true);
});
