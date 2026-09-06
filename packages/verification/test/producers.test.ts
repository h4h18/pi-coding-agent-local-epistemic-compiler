import { expect, test } from "vitest";
import type { CheckNode, ObjectDigest } from "@pi-hec/contracts";
import {
  collectedTestCount,
  findingsFromTask12,
  listingHasMismatch,
  memoryArtifacts,
  memoryHost,
  openApiKeys,
  parseCobertura,
  parseCompilerDiagnostics,
  parseJunitXml,
  parseLcov,
  parseSarif,
  parseTap,
  productionProducers,
} from "../src/index.js";
import { BINDINGS, CHECK, OBL, OBJECT, observation, seal } from "./helpers.js";

const XML = `<?xml version="1.0"?>
<testsuite tests="2" failures="1">
  <testcase classname="T" name="ok" assertions="1"/>
  <testcase classname="T" name="bad" assertions="1"><failure message="nope"/></testcase>
</testsuite>`;

const TAP = `TAP version 13
1..2
ok 1 - first
not ok 2 - second
`;

const SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ results: [{ ruleId: "x", level: "error", kind: "fail", message: { text: "bug" } }] }],
});

const LCOV = `TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n`;

const COBERTURA = `<coverage line-rate="0.5"><packages><package><classes><class filename="a.ts"><lines>
<line number="1" hits="1"/><line number="2" hits="0"/>
</lines></class></classes></package></packages></coverage>`;

function checkNode(
  intrinsicCheckId: string,
  subject: CheckNode["subject"] = "CANDIDATE",
): CheckNode {
  return {
    id: CHECK,
    obligationIds: [OBL],
    subject,
    recipe: { intrinsicCheckId, configurationObjectDigest: OBJECT },
    dependencies: [],
    mandatory: true,
    approval: "AUTO",
  };
}

function digest(fill: string): ObjectDigest {
  return `sha256:${fill.repeat(32)}` as ObjectDigest;
}

test("JUnit TAP SARIF LCOV Cobertura and compiler parsers affect obligations", async () => {
  expect(parseJunitXml(XML).some((item) => item.status === "failed")).toBe(true);
  expect(parseTap(TAP).points.some((item) => !item.ok)).toBe(true);
  expect(parseSarif(SARIF).some((item) => item.level === "error")).toBe(true);
  expect(parseLcov(LCOV).linesFound).toBeGreaterThan(0);
  expect(parseCobertura(COBERTURA).linesHit).toBe(1);
  expect(parseCompilerDiagnostics("src/a.ts:3:1: error: unknown identifier 'x'")).toHaveLength(1);
  expect(collectedTestCount('<testsuite tests="4">')).toBe(4);
  expect(listingHasMismatch("src/a.ts\tsha256:aa\tsha256:bb")).toBe(true);

  const stdout = digest("11");
  const artifacts = memoryArtifacts({ [stdout]: XML });
  const host = memoryHost({
    "junit.xml": XML,
    "results.tap": TAP,
    "analysis.sarif": SARIF,
    "coverage/lcov.info": LCOV,
    "coverage.xml": COBERTURA,
    "openapi.json": '{"openapi":"3.0.0","paths":{"/v1":{"get":{}}}}',
    "schema.graphql": "type Query { n: Int }",
    "api.proto": "message Box { int32 n = 1; }",
    "migrations/001.sql": "-- >>> 001\nCREATE TABLE t(id int);\n",
    "playwright.config.ts": "export default {}",
    "androidTest/x.xml": XML,
    "Example.xcresult": "Test Case '-[Foo testBar]' passed",
  });
  const producers = productionProducers(host, artifacts, BINDINGS);
  expect(producers.map((item) => item.id)).toEqual(
    expect.arrayContaining([
      "generic-process",
      "filesystem",
      "junit",
      "tap",
      "sarif",
      "coverage",
      "compiler-diagnostics",
      "openapi",
      "graphql",
      "protobuf",
      "abi",
      "sql-migration",
      "playwright",
      "android",
      "xctest",
      "local-semantic",
    ]),
  );
  const junit = producers.find((item) => item.id === "junit");
  expect(junit).toBeDefined();
  if (junit === undefined) {
    throw new Error("junit producer missing");
  }
  const records = await junit.parse(checkNode("junit-parse"), [
    observation("FAILED", 1, { stdoutArtifact: stdout, exitCode: 1 }),
  ]);
  expect(records[0]?.relation).toBe("REFUTES");
  expect(openApiKeys('{"openapi":"3.0.0","paths":{"/v1":{"get":{}}}}').has("GET /v1")).toBe(true);

  const capabilities = [];
  for (const producer of producers) {
    capabilities.push(...(await producer.probe(seal())));
  }
  expect(capabilities.length).toBeGreaterThan(0);
});

test("local semantic findings ingest as LOCAL_MODEL", async () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    candidateId: "candidate_01234567-89ab-7cde-8f01-23456789abcd",
    candidateManifestObjectDigest: BINDINGS.candidateManifestObjectDigest,
    findings: [
      {
        id: "finding-1",
        kind: "MISSING_EVIDENCE",
        statement: "open evidence",
        sourceRefs: [],
        requirementIds: ["req_" + "a".repeat(52)],
        confidence: "MEDIUM",
      },
    ],
  });
  const findings = findingsFromTask12(payload);
  expect(findings).toHaveLength(1);
  const stdout = digest("44");
  const producer = productionProducers(
    memoryHost({}),
    memoryArtifacts({ [stdout]: payload }),
    BINDINGS,
  ).find((item) => item.id === "local-semantic");
  expect(producer).toBeDefined();
  if (producer === undefined) {
    throw new Error("local-semantic producer missing");
  }
  const records = await producer.parse(checkNode("local-semantic-ingest"), [
    observation("PASSED", 1, { stdoutArtifact: stdout }),
  ]);
  expect(records[0]?.origin).toBe("LOCAL_MODEL");
  expect(records[0]?.relation).toBe("NEUTRAL");
});

test("OpenAPI GraphQL protobuf producers parse paired artifacts or yield no PASS/FAIL", async () => {
  const paired = "type Query { n: Int }\n---CANDIDATE---\ntype Query { n: Int }\n";
  const stdout = digest("55");
  const graphql = productionProducers(
    memoryHost({ "schema.graphql": paired }),
    memoryArtifacts({ [stdout]: paired }),
    BINDINGS,
  ).find((item) => item.id === "graphql");
  expect(graphql).toBeDefined();
  if (graphql === undefined) {
    throw new Error("graphql producer missing");
  }
  const records = await graphql.parse(checkNode("graphql-diff", "PAIRED"), [
    observation("PASSED", 1, { stdoutArtifact: stdout, exitCode: 0 }),
  ]);
  expect(records[0]?.relation).toBe("SUPPORTS");
  const noPair = productionProducers(
    memoryHost({ "schema.graphql": "type Query { n: Int }" }),
    memoryArtifacts({}),
    BINDINGS,
  ).find((item) => item.id === "graphql");
  expect(noPair).toBeDefined();
  if (noPair === undefined) {
    throw new Error("graphql producer missing");
  }
  const none = await noPair.parse(checkNode("graphql-diff", "PAIRED"), []);
  expect(none).toEqual([]);
});
