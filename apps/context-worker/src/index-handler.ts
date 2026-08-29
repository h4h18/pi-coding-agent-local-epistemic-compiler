import {
  incrementallyUpdateIndex,
  openIndexDatabase,
  rebuildSnapshotIndex,
  searchBm25,
  searchVector,
  type IncrementalUpdateInput,
  type RebuildIndexInput,
  type RebuildIndexResult,
  type SearchHit,
} from "@pi-hec/repository";

export async function handleRebuildIndex(input: RebuildIndexInput): Promise<RebuildIndexResult> {
  return rebuildSnapshotIndex(input);
}

export async function handleIncrementalIndex(input: IncrementalUpdateInput): Promise<RebuildIndexResult> {
  return incrementallyUpdateIndex(input);
}

export function handleSearchBm25(
  dbPath: string,
  query: string,
  options?: { limit?: number; language?: string },
): SearchHit[] {
  const db = openIndexDatabase(dbPath);
  try {
    return searchBm25(db, query, options ?? {});
  } finally {
    db.close();
  }
}

export function handleSearchVector(
  dbPath: string,
  query: string,
  options?: { k?: number; language?: string },
): SearchHit[] {
  const db = openIndexDatabase(dbPath);
  try {
    return searchVector(db, query, options ?? {});
  } finally {
    db.close();
  }
}
