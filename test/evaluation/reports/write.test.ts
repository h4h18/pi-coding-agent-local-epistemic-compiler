import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runEvaluationHarness } from "../harness/evaluate.js";
import { assertLocalReportPath, reportTelemetryDenied, writeLocalReports } from "./write.js";

const REPORTS_DIR = path.dirname(fileURLToPath(import.meta.url));

test("reports are written under test/evaluation/reports as local files with no network telemetry", async () => {
  const target = path.join(REPORTS_DIR, "generated");
  const result = await runEvaluationHarness({ reportDir: target });
  expect(result.holdoutGatesClaimed).toBe(false);
  expect(result.eligibilityBeforeReveal).toBe(true);
  expect(result.paired).toBe(3);
  expect(result.telemetry).toEqual({ network: false, prometheus: false, otel: false });
  expect(reportTelemetryDenied()).toEqual({ network: false, prometheus: false, otel: false });
  for (const filePath of result.reports) {
    expect(filePath.startsWith(REPORTS_DIR)).toBe(true);
    expect(filePath.includes("://")).toBe(false);
    const body = await readFile(filePath, "utf8");
    expect(body.length).toBeGreaterThan(2);
  }
  const coverage = JSON.parse(await readFile(path.join(target, "coverage.json"), "utf8")) as {
    holdoutGatesClaimed: boolean;
    underpowered: boolean;
  };
  expect(coverage.holdoutGatesClaimed).toBe(false);
  expect(coverage.underpowered).toBe(true);
  expect(() => assertLocalReportPath("https://example.invalid/metrics")).toThrow(/local files/);
  await expect(writeLocalReports("https://example.invalid/out", { "x.json": {} })).rejects.toThrow(/local files/);
});

test("writeLocalReports refuses remote targets even inside a temp directory name", async () => {
  const local = mkdtempSync(path.join(tmpdir(), "hec-eval-reports-"));
  const written = await writeLocalReports(local, { "frozen-manifest.json": { local: true } });
  expect(written[0]?.startsWith(local)).toBe(true);
});
