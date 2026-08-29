export function retrievalQueryRecall(
  rows: readonly { relevant: readonly string[]; retrieved: readonly string[] }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const row of rows) {
    if (row.relevant.length === 0) {
      sum += 1;
      continue;
    }
    const retrieved = new Set(row.retrieved);
    let hits = 0;
    for (const id of row.relevant) {
      if (retrieved.has(id)) {
        hits += 1;
      }
    }
    sum += hits / row.relevant.length;
  }
  return sum / rows.length;
}

function gradedGain(goldOrder: readonly string[], id: string): number {
  const goldIndex = goldOrder.indexOf(id);
  if (goldIndex === -1) {
    return 0;
  }
  return goldOrder.length - goldIndex;
}

function dcg(order: readonly string[], goldOrder: readonly string[], cutoff: number): number {
  let sum = 0;
  const limit = Math.min(cutoff, order.length);
  for (let index = 0; index < limit; index += 1) {
    const id = order[index];
    if (id === undefined) {
      continue;
    }
    const gain = gradedGain(goldOrder, id);
    if (gain === 0) {
      continue;
    }
    sum += gain / Math.log2(index + 2);
  }
  return sum;
}

export function rerankNdcg(
  rows: readonly { goldOrder: readonly string[]; predictedOrder: readonly string[] }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const row of rows) {
    const ideal = dcg(row.goldOrder, row.goldOrder, row.goldOrder.length);
    if (ideal === 0) {
      sum += 1;
      continue;
    }
    sum += dcg(row.predictedOrder, row.goldOrder, row.goldOrder.length) / ideal;
  }
  return sum / rows.length;
}

export function rerankMrr(
  rows: readonly { goldOrder: readonly string[]; predictedOrder: readonly string[] }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const row of rows) {
    const firstGold = row.goldOrder[0];
    if (firstGold === undefined) {
      sum += 1;
      continue;
    }
    const rank = row.predictedOrder.indexOf(firstGold);
    sum += rank === -1 ? 0 : 1 / (rank + 1);
  }
  return sum / rows.length;
}

export function citationPrecision(
  rows: readonly { predicted: readonly string[]; gold: readonly string[] }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const row of rows) {
    if (row.predicted.length === 0) {
      sum += 0;
      continue;
    }
    const gold = new Set(row.gold);
    let hits = 0;
    for (const id of row.predicted) {
      if (gold.has(id)) {
        hits += 1;
      }
    }
    sum += hits / row.predicted.length;
  }
  return sum / rows.length;
}

export function contradictionUnknownRecall(
  rows: readonly { predicted: string; gold: string }[],
): number {
  const targets = rows.filter((row) => row.gold === "contradict" || row.gold === "unknown");
  if (targets.length === 0) {
    return 1;
  }
  let hits = 0;
  for (const row of targets) {
    if (row.predicted === row.gold) {
      hits += 1;
    }
  }
  return hits / targets.length;
}

export function semanticFindingPrecision(
  rows: readonly { predictedRelevant: boolean; goldRelevant: boolean }[],
): number {
  let truePositive = 0;
  let falsePositive = 0;
  for (const row of rows) {
    if (row.predictedRelevant && row.goldRelevant) {
      truePositive += 1;
    } else if (row.predictedRelevant && !row.goldRelevant) {
      falsePositive += 1;
    }
  }
  const denom = truePositive + falsePositive;
  return denom === 0 ? 1 : truePositive / denom;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const expectedType = schema.type;
  if (expectedType === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return false;
        }
      }
    }
    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key)) {
          continue;
        }
        if (
          typeof propertySchema === "object" &&
          propertySchema !== null &&
          !matchesJsonSchema((value as Record<string, unknown>)[key], propertySchema as Record<string, unknown>)
        ) {
          return false;
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed =
        typeof properties === "object" && properties !== null ? new Set(Object.keys(properties)) : new Set<string>();
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          return false;
        }
      }
    }
    return true;
  }
  if (typeof expectedType === "string") {
    return jsonTypeOf(value) === expectedType;
  }
  return true;
}

export function jsonSchemaReliability(
  rows: readonly { predicted: string; schema: Record<string, unknown> }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.predicted);
      if (matchesJsonSchema(parsed, row.schema)) {
        hits += 1;
      }
    } catch {
      continue;
    }
  }
  return hits / rows.length;
}

export function roleIsolationScore(
  rows: readonly { invokedCloudCompletion: boolean; invokedRepositoryTool: boolean }[],
): number {
  if (rows.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const row of rows) {
    if (!row.invokedCloudCompletion && !row.invokedRepositoryTool) {
      hits += 1;
    }
  }
  return hits / rows.length;
}

export function longContextAccuracy(rows: readonly { predicted: string; gold: string }[]): number {
  if (rows.length === 0) {
    return 0;
  }
  let hits = 0;
  for (const row of rows) {
    if (row.predicted === row.gold) {
      hits += 1;
    }
  }
  return hits / rows.length;
}
