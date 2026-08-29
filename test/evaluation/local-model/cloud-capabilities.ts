import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import {
  DeploymentCapabilitiesSchema,
  sha256Hex,
  type DeploymentCapabilities,
} from "@pi-hec/contracts";

const validator = Compile(DeploymentCapabilitiesSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CloudTranscript = {
  lookupByRequestIdentityCannotCreateCompletion: boolean;
  durableProviderOperationId?: string | null;
};

export type LoadedCloudRecord = {
  capabilities: DeploymentCapabilities;
  rawFixtureRelativePath: string;
  transcript: CloudTranscript;
};

export type CloudValidationResult = { ok: true } | { ok: false; reason: string };

export function validateCloudCapabilityRecord(input: {
  capabilities: unknown;
  transcript: CloudTranscript;
  rawFixtureBytes: Buffer;
}): CloudValidationResult {
  if (!validator.Check(input.capabilities)) {
    return { ok: false, reason: "schema-invalid" };
  }
  const capabilities = input.capabilities;
  const digest = sha256Hex(input.rawFixtureBytes);
  const evidence = capabilities.evidence[0];
  if (evidence !== undefined && evidence.conformanceResultObjectDigest !== digest) {
    return { ok: false, reason: "conformance-digest-mismatch" };
  }
  if (capabilities.recovery.grade === "A" && !input.transcript.lookupByRequestIdentityCannotCreateCompletion) {
    return { ok: false, reason: "grade-a-without-lookup-proof" };
  }
  if (
    capabilities.recovery.grade === "B" &&
    (input.transcript.durableProviderOperationId === undefined ||
      input.transcript.durableProviderOperationId === null ||
      input.transcript.durableProviderOperationId.length === 0)
  ) {
    return { ok: false, reason: "grade-b-without-operation-id" };
  }
  return { ok: true };
}

export async function loadCloudCapabilityRecords(modelsDir: string): Promise<LoadedCloudRecord[]> {
  const repoRoot = path.resolve(modelsDir, "..", "..");
  const names = (await readdir(modelsDir)).filter((name) => name.endsWith(".json")).sort();
  const fixtureDir = path.join(repoRoot, "test", "evaluation", "local-model", "fixtures", "cloud");
  const fixtureNames = (await readdir(fixtureDir)).filter((name) => name.endsWith(".json"));
  const fixtureByDigest = new Map<string, { relative: string; bytes: Buffer; transcript: CloudTranscript }>();
  for (const name of fixtureNames) {
    const relative = `test/evaluation/local-model/fixtures/cloud/${name}`;
    const bytes = await readFile(path.join(repoRoot, ...relative.split("/")));
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    const transcript: CloudTranscript = {
      lookupByRequestIdentityCannotCreateCompletion: false,
    };
    if (isRecord(parsed)) {
      transcript.lookupByRequestIdentityCannotCreateCompletion =
        parsed.lookupByRequestIdentityCannotCreateCompletion === true;
      if (typeof parsed.durableProviderOperationId === "string") {
        transcript.durableProviderOperationId = parsed.durableProviderOperationId;
      } else if (parsed.durableProviderOperationId === null) {
        transcript.durableProviderOperationId = null;
      }
    }
    fixtureByDigest.set(sha256Hex(bytes), { relative, bytes, transcript });
  }
  const records: LoadedCloudRecord[] = [];
  for (const name of names) {
    const raw: unknown = JSON.parse(await readFile(path.join(modelsDir, name), "utf8"));
    if (!isRecord(raw) || typeof raw.deploymentId !== "string" || raw.recovery === undefined) {
      continue;
    }
    if (!validator.Check(raw)) {
      throw new Error(`${name} failed DeploymentCapabilitiesSchema`);
    }
    const evidence = raw.evidence[0];
    if (evidence === undefined) {
      throw new Error(`${name} missing conformance evidence`);
    }
    const fixture = fixtureByDigest.get(evidence.conformanceResultObjectDigest);
    if (fixture === undefined) {
      throw new Error(`${name} conformance digest does not match a committed raw fixture`);
    }
    const validated = validateCloudCapabilityRecord({
      capabilities: raw,
      transcript: fixture.transcript,
      rawFixtureBytes: fixture.bytes,
    });
    if (!validated.ok) {
      throw new Error(`${name} ${validated.reason}`);
    }
    records.push({
      capabilities: raw,
      rawFixtureRelativePath: fixture.relative,
      transcript: fixture.transcript,
    });
  }
  return records;
}
