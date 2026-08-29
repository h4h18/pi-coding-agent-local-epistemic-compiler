import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts", "qualify-versions.ts")).href;

type LockEntryShape = {
  version: string;
  resolvedAt: string;
  sourceUrl: string;
};

type QualifyVersions = (options: {
  lockPath: string;
  resolveFromNetwork?: boolean;
  fetchImpl?: typeof fetch;
}) => Promise<{ ok: boolean; issues: readonly { message: string }[] }>;

type QualifyLockfile = (lockfile: unknown) => readonly { message: string }[];

async function loadQualifyScript(): Promise<{
  QUALIFIED_EXACT: Readonly<Record<string, string>>;
  qualifyLockfile: QualifyLockfile;
  qualifyVersions: QualifyVersions;
}> {
  return import(scriptUrl) as Promise<{
    QUALIFIED_EXACT: Readonly<Record<string, string>>;
    qualifyLockfile: QualifyLockfile;
    qualifyVersions: QualifyVersions;
  }>;
}

function lockEntry(version: string): LockEntryShape {
  return {
    version,
    resolvedAt: "2026-08-27T00:00:00.000Z",
    sourceUrl: "https://example.invalid/source",
  };
}

function qualifiedPackages(
  overrides: Record<string, LockEntryShape> = {},
): Record<string, LockEntryShape> {
  return {
    node: lockEntry("24.20.0"),
    pnpm: lockEntry("12.0.0"),
    typescript: lockEntry("6.0.3"),
    typebox: lockEntry("1.3.19"),
    fastify: lockEntry("5.12.1"),
    "@fastify/type-provider-typebox": lockEntry("6.1.0"),
    "better-sqlite3": lockEntry("13.0.3"),
    "@earendil-works/pi-coding-agent": lockEntry("0.84.3"),
    "@earendil-works/pi-ai": lockEntry("0.84.3"),
    "@earendil-works/pi-tui": lockEntry("0.84.3"),
    "@earendil-works/pi-agent-core": lockEntry("0.84.3"),
    vitest: lockEntry("4.1.11"),
    "fast-check": lockEntry("4.9.0"),
    eslint: lockEntry("10.9.1"),
    "typescript-eslint": lockEntry("8.68.0"),
    prettier: lockEntry("3.9.6"),
    pino: lockEntry("10.3.1"),
    "sqlite-vec": lockEntry("0.1.9"),
    "@types/node": lockEntry("24.13.3"),
    rustc: lockEntry("1.98.0"),
    "cargo-nextest": lockEntry("0.9.143"),
    ...overrides,
  };
}

function qualifiedLockfile(packageOverrides: Record<string, LockEntryShape> = {}): {
  packages: Record<string, LockEntryShape>;
  discoveredRejected: {
    typescript: LockEntryShape & { reason: string };
  };
} {
  return {
    packages: qualifiedPackages(packageOverrides),
    discoveredRejected: {
      typescript: {
        ...lockEntry("7.0.2"),
        reason: "no programmatic compiler API; cannot drive type-aware ESLint",
      },
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function npmPackument(latest: string, extraTags: Record<string, string> = {}): unknown {
  const versions: Record<string, Record<string, never>> = { [latest]: {} };
  for (const version of Object.values(extraTags)) {
    versions[version] = {};
  }
  return {
    "dist-tags": { latest, ...extraTags },
    versions,
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function matchingFloorFetch(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const url = requestUrl(input);
  if (url.includes("nodejs.org/dist/index.json")) {
    return Promise.resolve(
      jsonResponse([
        { version: "v26.0.0", lts: false },
        { version: "v25.2.1", lts: false },
        { version: "v24.20.0", lts: "Krypton" },
      ]),
    );
  }
  if (url.includes("registry.npmjs.org/pnpm")) {
    return Promise.resolve(jsonResponse(npmPackument("11.24.0", { "next-12": "12.0.0" })));
  }
  if (url.includes("registry.npmjs.org/typescript") && !url.includes("typescript-eslint")) {
    return Promise.resolve(jsonResponse(npmPackument("7.0.2", { "next-6": "6.0.3" })));
  }
  if (url.includes("typebox")) {
    return Promise.resolve(jsonResponse(npmPackument("1.3.19")));
  }
  if (url.includes("fastify") && !url.includes("type-provider")) {
    return Promise.resolve(jsonResponse(npmPackument("5.12.1")));
  }
  if (url.includes("type-provider-typebox")) {
    return Promise.resolve(jsonResponse(npmPackument("6.1.0")));
  }
  if (url.includes("better-sqlite3")) {
    return Promise.resolve(jsonResponse(npmPackument("13.0.3")));
  }
  if (url.includes("@earendil-works") || url.includes("%40earendil-works")) {
    return Promise.resolve(jsonResponse(npmPackument("0.84.3")));
  }
  if (url.includes("vitest")) {
    return Promise.resolve(jsonResponse(npmPackument("4.1.11")));
  }
  if (url.includes("fast-check")) {
    return Promise.resolve(jsonResponse(npmPackument("4.9.0")));
  }
  if (url.includes("typescript-eslint")) {
    return Promise.resolve(jsonResponse(npmPackument("8.68.0")));
  }
  if (url.includes("eslint")) {
    return Promise.resolve(jsonResponse(npmPackument("10.9.1")));
  }
  if (url.includes("prettier")) {
    return Promise.resolve(jsonResponse(npmPackument("3.9.6")));
  }
  if (url.includes("pino")) {
    return Promise.resolve(jsonResponse(npmPackument("10.3.1")));
  }
  if (url.includes("sqlite-vec")) {
    return Promise.resolve(jsonResponse(npmPackument("0.1.9")));
  }
  if (url.includes("@types/node") || url.includes("%40types%2Fnode")) {
    return Promise.resolve(
      jsonResponse({
        "dist-tags": { latest: "26.0.0" },
        versions: { "26.0.0": {}, "24.13.3": {}, "24.12.0": {} },
      }),
    );
  }
  if (url.includes("channel-rust-stable.toml")) {
    return Promise.resolve(
      textResponse(
        `manifest-version = "2"\ndate = "2026-08-20"\n\n[pkg.rustc]\nversion = "1.98.0 (abc 2026-08-20)"\n`,
      ),
    );
  }
  if (url.includes("crates.io/api/v1/crates/cargo-nextest")) {
    return Promise.resolve(
      jsonResponse({ crate: { max_stable_version: "0.9.143", max_version: "0.9.143" } }),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

async function withTempLock(
  lockfile: unknown,
  run: (lockPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "hec-qualify-"));
  const lockPath = path.join(dir, "versions.lock.json");
  try {
    await writeFile(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
    await run(lockPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void test("repository versions.lock.json qualifies against Task 1 floors", async () => {
  const { qualifyVersions } = await loadQualifyScript();
  const result = await qualifyVersions({
    lockPath: path.join(repoRoot, "config", "versions.lock.json"),
    resolveFromNetwork: false,
  });
  assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("\n"));
});

void test("refuses a Node Current 26 pin", async () => {
  const { qualifyLockfile } = await loadQualifyScript();
  const issues = qualifyLockfile(qualifiedLockfile({ node: lockEntry("26.0.0") }));
  assert.ok(issues.length > 0);
  assert.ok(
    issues.some((issue) => /node/i.test(issue.message) && /26/.test(issue.message)),
    issues.map((issue) => issue.message).join("\n"),
  );
});

void test("fails when a required lockfile key is missing or a pin is not exact", async () => {
  const { qualifyLockfile } = await loadQualifyScript();
  const missingPnpm = qualifiedLockfile();
  delete missingPnpm.packages.pnpm;
  const missingIssues = qualifyLockfile(missingPnpm);
  assert.ok(
    missingIssues.some((issue) => /pnpm/i.test(issue.message)),
    missingIssues.map((issue) => issue.message).join("\n"),
  );
  const rangedIssues = qualifyLockfile(qualifiedLockfile({ prettier: lockEntry("^3.9.6") }));
  assert.ok(
    rangedIssues.some((issue) => /prettier/i.test(issue.message) && /exact/i.test(issue.message)),
    rangedIssues.map((issue) => issue.message).join("\n"),
  );
});

void test("refuses an @types/node 26.x pin", async () => {
  const { qualifyLockfile } = await loadQualifyScript();
  const issues = qualifyLockfile(qualifiedLockfile({ "@types/node": lockEntry("26.0.0") }));
  assert.ok(
    issues.some((issue) => /@types\/node/i.test(issue.message) && /26/.test(issue.message)),
    issues.map((issue) => issue.message).join("\n"),
  );
});

void test("--resolve re-resolves every qualified floor and keeps the Task 1 lock", async () => {
  const { QUALIFIED_EXACT, qualifyVersions } = await loadQualifyScript();
  const fetched: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    fetched.push(requestUrl(input));
    return matchingFloorFetch(input);
  };
  await withTempLock(qualifiedLockfile(), async (lockPath) => {
    const result = await qualifyVersions({
      lockPath,
      resolveFromNetwork: true,
      fetchImpl,
    });
    assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("\n"));
  });
  const blob = fetched.join("\n");
  for (const name of Object.keys(QUALIFIED_EXACT)) {
    if (name === "node") {
      assert.ok(blob.includes("nodejs.org/dist/index.json"), "must fetch Node dist index.json");
      continue;
    }
    if (name === "rustc") {
      assert.ok(
        blob.includes("static.rust-lang.org/dist/channel-rust-stable.toml"),
        "must fetch rust-lang stable channel",
      );
      continue;
    }
    if (name === "cargo-nextest") {
      assert.ok(
        blob.includes("crates.io/api/v1/crates/cargo-nextest"),
        "must fetch cargo-nextest from crates.io",
      );
      continue;
    }
    const encoded = encodeURIComponent(name);
    assert.ok(
      blob.includes(`registry.npmjs.org/${name}`) || blob.includes(`registry.npmjs.org/${encoded}`),
      `must fetch npm packument for ${name}`,
    );
  }
});

void test("--resolve refuses Node Current 25/26 even if marked LTS", async () => {
  const { qualifyVersions } = await loadQualifyScript();
  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    if (url.includes("nodejs.org/dist/index.json")) {
      return Promise.resolve(
        jsonResponse([
          { version: "v26.1.0", lts: "Krypton" },
          { version: "v25.0.0", lts: false },
        ]),
      );
    }
    return matchingFloorFetch(input);
  };
  await withTempLock(qualifiedLockfile(), async (lockPath) => {
    const result = await qualifyVersions({
      lockPath,
      resolveFromNetwork: true,
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.issues.some((issue) => /node/i.test(issue.message) && /26/.test(issue.message)),
      result.issues.map((issue) => issue.message).join("\n"),
    );
  });
});

void test("--resolve does not fail the lockfile for TypeScript 6.0.3 vs latest 7.0.2", async () => {
  const { qualifyVersions } = await loadQualifyScript();
  await withTempLock(qualifiedLockfile(), async (lockPath) => {
    const result = await qualifyVersions({
      lockPath,
      resolveFromNetwork: true,
      fetchImpl: matchingFloorFetch,
    });
    assert.equal(result.ok, true, result.issues.map((issue) => issue.message).join("\n"));
    assert.equal(
      result.issues.some((issue) => /typescript 6\.0\.3/i.test(issue.message)),
      false,
      result.issues.map((issue) => issue.message).join("\n"),
    );
  });
});
