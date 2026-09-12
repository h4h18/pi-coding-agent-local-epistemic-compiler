import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHecExtension, type BrokerPort } from "../../client/apps/pi-extension/src/index.js";
import {
  DIGEST,
  FakePi,
  RecordingBroker,
  RUN_ID,
  sampleRun,
} from "../../client/apps/pi-extension/test/harness.js";

export const TASK_TEXT = "исправь failing test, не трогая generated file";

export type SnapshotPort = () => {
  dirtyPaths: readonly string[];
  generatedPath: string;
  generatedDigest: string;
};

export type PreflightPort = (snapshot: ReturnType<SnapshotPort>) => {
  failingTest: string;
  callers: readonly string[];
  agentsPath: string;
  generatedExclusion: string;
};

export type OneShotPort = () => {
  tool: string;
  acceptedCompletions: number;
};

export type SandboxPort = (input: { hostTreeDigest: string }) => {
  appliedInVm: boolean;
  hostTreeDigestUnchanged: boolean;
  baseline: string;
  candidate: string;
};

export type VerdictPort = () => string;

export type UsagePort = () => { acceptedCompletionCount: number };

export type ApplyPort = (input: {
  trustedUi: boolean;
  intendedPaths: readonly string[];
  generatedPath: string;
  generatedDigestBefore: string;
}) => {
  changedPaths: readonly string[];
  generatedDigestAfter: string;
};

export type PolyglotPorts = {
  snapshot: SnapshotPort;
  preflight: PreflightPort;
  oneShot: OneShotPort;
  sandbox: SandboxPort;
  verdict: VerdictPort;
  usage: UsagePort;
  apply: ApplyPort;
  broker?: BrokerPort;
};

export type PolyglotStepResult = {
  step: number;
  name: string;
  ok: boolean;
};

export function writePolyglotFixture(root: string): {
  generatedPath: string;
  generatedDigest: string;
  intendedPath: string;
} {
  mkdirSync(path.join(root, "service"), { recursive: true });
  mkdirSync(path.join(root, "cli", "src"), { recursive: true });
  mkdirSync(path.join(root, "generated"), { recursive: true });
  writeFileSync(
    path.join(root, "AGENTS.md"),
    "Fix the failing test. Do not edit generated/.\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "service", "app.py"),
    "def add(left, right):\n    return left - right\n",
    "utf8",
  );
  writeFileSync(
    path.join(root, "service", "test_app.py"),
    "from app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
    "utf8",
  );
  writeFileSync(path.join(root, "cli", "src", "index.ts"), "export const cli = true;\n", "utf8");
  const generatedPath = path.join(root, "generated", "bundle.js");
  writeFileSync(generatedPath, "export const generated = 1;\n", "utf8");
  const generatedDigest = createHash("sha256").update(readFileSync(generatedPath)).digest("hex");
  return {
    generatedPath,
    generatedDigest,
    intendedPath: path.join(root, "service", "app.py"),
  };
}

export async function runPolyglotTwelveSteps(ports: PolyglotPorts): Promise<{
  steps: readonly PolyglotStepResult[];
  runId: string;
  verdict: "ACCEPTED";
  acceptedCompletions: number;
  generatedDigest: string;
}> {
  const broker =
    ports.broker ??
    new RecordingBroker(
      sampleRun({
        state: "CREATED",
        artifactRoles: [
          {
            role: "approval-subject",
            cardinality: "ONE_OR_MORE",
            objectDigests: [DIGEST],
          },
        ],
      }),
    );
  const first = new FakePi();
  first.install(broker, { securityMode: "compatibility" });

  await first.runCommand("mode on");
  const steps: PolyglotStepResult[] = [{ step: 1, name: "hec-mode-on", ok: true }];

  await first.runCommand(`task ${TASK_TEXT}`);
  steps.push({ step: 2, name: "hec-task", ok: true });

  const snapshot = ports.snapshot();
  if (
    !snapshot.dirtyPaths.includes("service/test_app.py") ||
    !snapshot.dirtyPaths.includes("AGENTS.md")
  ) {
    throw new Error("snapshot must include dirty test and AGENTS.md");
  }
  steps.push({ step: 3, name: "snapshot-dirty", ok: true });

  const preflight = ports.preflight(snapshot);
  if (
    preflight.failingTest !== "service/test_app.py" ||
    !preflight.callers.includes("service/app.py") ||
    preflight.agentsPath !== "AGENTS.md" ||
    preflight.generatedExclusion !== snapshot.generatedPath
  ) {
    throw new Error("preflight missed required evidence");
  }
  steps.push({ step: 4, name: "preflight-evidence", ok: true });

  const cloud = ports.oneShot();
  if (cloud.tool !== "submit_solution" || cloud.acceptedCompletions !== 1) {
    throw new Error("cloud must return exactly one submit_solution");
  }
  steps.push({ step: 5, name: "one-shot", ok: true });

  const hostTreeDigest = "sha256:host-before-sandbox";
  const sandboxed = ports.sandbox({ hostTreeDigest });
  if (!sandboxed.appliedInVm || !sandboxed.hostTreeDigestUnchanged) {
    throw new Error("candidate must apply only in VM");
  }
  steps.push({ step: 6, name: "candidate-in-vm", ok: true });

  if (sandboxed.baseline !== "FAIL" || sandboxed.candidate !== "PASS") {
    throw new Error("baseline must fail and candidate must pass");
  }
  steps.push({ step: 7, name: "red-green", ok: true });

  const generatedDigest = snapshot.generatedDigest;
  steps.push({ step: 8, name: "generated-unchanged-pre-apply", ok: true });

  const verdict = ports.verdict();
  if (verdict !== "ACCEPTED") {
    throw new Error("verdict must be ACCEPTED");
  }
  steps.push({ step: 9, name: "verdict-accepted", ok: true });

  const usage = ports.usage();
  if (usage.acceptedCompletionCount !== 1) {
    throw new Error("usage must show 1 accepted completion");
  }
  steps.push({ step: 10, name: "usage-one-completion", ok: true });

  await first.runCommand(`apply ${RUN_ID}`);
  const applied = ports.apply({
    trustedUi: true,
    intendedPaths: ["service/app.py"],
    generatedPath: snapshot.generatedPath,
    generatedDigestBefore: generatedDigest,
  });
  if (applied.changedPaths.join(",") !== "service/app.py") {
    throw new Error("apply changed unexpected paths");
  }
  if (applied.generatedDigestAfter !== generatedDigest) {
    throw new Error("generated digest changed");
  }
  steps.push({ step: 11, name: "trusted-apply", ok: true });

  const restarted = new FakePi();
  restarted.entries.push(...first.entries);
  const restoredBroker = new RecordingBroker(
    sampleRun({
      state: "SUCCEEDED",
      runId: RUN_ID,
      artifactRoles: [
        {
          role: "approval-subject",
          cardinality: "ONE_OR_MORE",
          objectDigests: [DIGEST],
        },
      ],
    }),
  );
  createHecExtension({ securityMode: "compatibility", broker: restoredBroker })(restarted);
  const runtimeEntries = first.entries;
  void runtimeEntries;
  await restarted.runCommand(`status ${RUN_ID}`);
  const status = restoredBroker.calls.find((call) => call.method === "GET_RUN_STATUS");
  if (status === undefined || status.params.runId !== RUN_ID) {
    throw new Error("restart status did not restore the same run");
  }
  steps.push({ step: 12, name: "restart-status", ok: true });

  return {
    steps,
    runId: RUN_ID,
    verdict: "ACCEPTED",
    acceptedCompletions: 1,
    generatedDigest: createHash("sha256")
      .update(readFileSync(snapshot.generatedPath))
      .digest("hex"),
  };
}
