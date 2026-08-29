export const QUALITY_FLOOR_VERSION = "pi-hec-local-model-quality-floors/v1";

export const QUALITY_FLOORS = {
  retrievalQueryRecall: 0.7,
  rerankNdcg: 0.6,
  rerankMrr: 0.5,
  citationPrecision: 0.9,
  contradictionUnknownRecall: 0.8,
  semanticFindingPrecision: 0.85,
  jsonSchemaReliability: 0.99,
  roleIsolation: 1,
  longContextAccuracy: 0.9,
} as const;

export type QualityMetricName = keyof typeof QUALITY_FLOORS;
