import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { GOLDEN_REPO_IDS, GOLDEN_TASKS, TASK_KINDS } from "./index.js";
import { goldenGeneratedReportDir, runGoldenSuite } from "./suite.js";

test(
  "golden suite scores every repo/kind arm and writes local metrics reports",
  async () => {
    const report = await runGoldenSuite(goldenGeneratedReportDir());
    expect(GOLDEN_TASKS).toHaveLength(GOLDEN_REPO_IDS.length * TASK_KINDS.length);
    expect(report.arms.gold.headline.trialCount).toBe(90);
    expect(report.arms["false-ready"].headline.trialCount).toBe(90);
    expect(report.arms["honest-blocked"].headline.trialCount).toBe(90);
    expect(report.arms.repair.headline.trialCount).toBe(GOLDEN_REPO_IDS.length);
    expect(report.arms.gold.headline.acceptanceSuccess).toBe(1);
    expect(report.arms.gold.headline.scopePrecision).toBe(1);
    expect(report.arms.gold.headline.falseReadyRate).toBe(0);
    expect(report.arms["false-ready"].headline.falseReadyRate).toBe(1);
    expect(report.arms["false-ready"].headline.falseReadyByIntent["security-remediation"]).toBe(1);
    expect(report.arms["false-ready"].headline.falseReadyByIntent.migration).toBe(1);
    expect(report.arms["false-ready"].headline.falseReadyByIntent.optimization).toBe(1);
    expect(report.arms["honest-blocked"].headline.falseReadyRate).toBe(0);
    expect(report.confusion.goldFalseReady).toBe(0);
    expect(report.confusion.falseReadyCaught).toBe(90);
    expect(report.confusion.honestBlockedFalseReady).toBe(0);
    expect(report.primaryMetric.name).toBe("falseReadyRate");
    expect(report.written.some((filePath) => filePath.endsWith("golden-metrics.json"))).toBe(true);
    expect(existsSync(report.written[0] ?? "")).toBe(true);
  },
  180_000,
);
