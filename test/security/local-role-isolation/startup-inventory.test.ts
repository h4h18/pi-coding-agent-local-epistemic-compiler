import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyEvidenceGraph } from "@pi-hec/evidence";
import {
  collectStartupInventory,
  createIsolatedLocalRuntime,
  createPinnedLocalProvider,
  openProductionLocalSeal,
} from "@pi-hec/models";
import { createLocalAnalystSession, measureSessionInventory } from "@pi-hec/preflight";
import { expect, test } from "vitest";
import { DIGEST, RUN, SNAP, loopbackSeal } from "../../../packages/preflight/test/fixtures.js";
import { startAnalystMockServer } from "../../../packages/preflight/test/mock-openai-server.js";

async function snapshotTree(): Promise<{ root: string; paths: ReadonlySet<string> }> {
  const root = await mkdtemp(path.join(tmpdir(), "hec-inv-snap-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "main.ts"), "export const n = 1;\n", "utf8");
  return { root, paths: new Set(["src/main.ts"]) };
}

function toolDeps(snapshotRoot: string, paths: ReadonlySet<string>) {
  const graph = emptyEvidenceGraph(SNAP);
  return {
    snapshotRoot,
    snapshotId: SNAP,
    snapshotPaths: paths,
    channelHost: {
      snapshotId: SNAP,
      nowIso: () => "2026-08-28T00:00:00.000Z",
      graph,
      runId: RUN,
    },
    resolveInstructionScope: () => [],
    getGitHistory: () =>
      Promise.resolve({
        evidenceIds: [],
        sourceRefs: [],
        quoteDigest: DIGEST,
        contentDigest: DIGEST,
      }),
    getTestObservations: () =>
      Promise.resolve({
        evidenceIds: [],
        sourceRefs: [],
        quoteDigest: DIGEST,
        contentDigest: DIGEST,
      }),
    proposalSink: {
      persistActions: () => undefined,
      persistAudit: () => undefined,
    },
    graph,
  };
}

test("production selected set operator-pins Qwen3.8-27B on the FA-EX1 loopback runtime", async () => {
  const seal = await openProductionLocalSeal();
  expect(seal?.modelId).toBe("Qwen/Qwen3.8-27B");
  expect(seal?.baseUrl).toBe("http://127.0.0.1:8000/v1");
});

test("http://example.com and http://10.0.0.1 seals are denied without network", () => {
  expect(() =>
    createPinnedLocalProvider({
      ...loopbackSeal(1),
      baseUrl: "http://example.com/v1",
    }),
  ).toThrow(/127\.0\.0\.1/);
  expect(() =>
    createPinnedLocalProvider({
      ...loopbackSeal(1),
      baseUrl: "http://10.0.0.1:80/v1",
    }),
  ).toThrow(/127\.0\.0\.1/);
});

test("startup inventory: no cloud selectable/callable deployment, no provider credential, non-local denied", async () => {
  const mock = await startAnalystMockServer();
  const { root, paths } = await snapshotTree();
  try {
    const created = await createIsolatedLocalRuntime(loopbackSeal(mock.port));
    const session = await createLocalAnalystSession({
      snapshotRoot: root,
      seal: loopbackSeal(mock.port),
      toolDeps: toolDeps(root, paths),
      modelRuntime: created.modelRuntime,
    });
    try {
      const inventory = await collectStartupInventory(created, measureSessionInventory(session));
      expect(inventory.cloudDeploymentSelectable).toBe(false);
      expect(inventory.cloudDeploymentCallable).toBe(false);
      expect(inventory.providerCredentialCount).toBe(0);
      expect(inventory.defaultResourceAvailable).toBe(false);
      expect(inventory.extensionToolAvailable).toBe(false);
      expect(inventory.builtinToolAvailable).toBe(false);
      expect(inventory.nonLoopbackDenied).toBe(true);
      expect(inventory.osIdentitySeparated).toBe(false);
      const names = [...session.session.getActiveToolNames()];
      expect(names).not.toContain("bash");
      expect(names).not.toContain("read");
      const available = await created.modelRuntime.getAvailable();
      expect(available.every((model) => model.provider === "hec-local")).toBe(true);
    } finally {
      session.session.dispose();
    }
  } finally {
    await mock.close();
  }
});

test("root pnpm test script invokes pnpm test:security", async () => {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: { test?: string } };
  expect(pkg.scripts?.test ?? "").toContain("pnpm test:security");
});
