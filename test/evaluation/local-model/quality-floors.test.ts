import { expect, test } from "vitest";
import { QUALITY_FLOOR_VERSION, QUALITY_FLOORS } from "./quality-floors.js";

test("quality floors are versioned numeric gates for every §21.3 required metric", () => {
  expect(QUALITY_FLOOR_VERSION).toBe("pi-hec-local-model-quality-floors/v1");
  expect(QUALITY_FLOORS.retrievalQueryRecall).toBe(0.7);
  expect(QUALITY_FLOORS.rerankNdcg).toBe(0.6);
  expect(QUALITY_FLOORS.rerankMrr).toBe(0.5);
  expect(QUALITY_FLOORS.citationPrecision).toBe(0.9);
  expect(QUALITY_FLOORS.contradictionUnknownRecall).toBe(0.8);
  expect(QUALITY_FLOORS.semanticFindingPrecision).toBe(0.85);
  expect(QUALITY_FLOORS.jsonSchemaReliability).toBe(0.99);
  expect(QUALITY_FLOORS.roleIsolation).toBe(1);
  expect(QUALITY_FLOORS.longContextAccuracy).toBe(0.9);
  for (const value of Object.values(QUALITY_FLOORS)) {
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);
  }
});
