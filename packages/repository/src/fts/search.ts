import { lexicalTokens, ftsQueryFromText } from "./tokenize.js";
import type { SearchHit } from "../ingestion/types.js";
import type { SqliteDatabase } from "../index-db.js";

export function indexUnitFts(
  db: SqliteDatabase,
  evidenceId: string,
  path: string,
  symbolId: string,
  body: string,
): void {
  db.prepare("INSERT INTO units_fts(evidence_id, path, symbol_id, body) VALUES (?, ?, ?, ?)").run(
    evidenceId,
    path,
    symbolId,
    body,
  );
  const insertToken = db.prepare(
    "INSERT OR IGNORE INTO lexical_tokens(token_folded, evidence_id) VALUES (?, ?)",
  );
  for (const token of lexicalTokens(`${path} ${symbolId} ${body}`)) {
    insertToken.run(token, evidenceId);
  }
}

export function searchBm25(
  db: SqliteDatabase,
  query: string,
  options: { limit?: number; language?: string } = {},
): SearchHit[] {
  const limit = options.limit ?? 20;
  const match = ftsQueryFromText(query);
  const language = options.language;
  const sql =
    language === undefined
      ? `SELECT units.evidence_id AS evidenceId, units.path AS path, units.symbol_id AS symbolId,
                units.language AS language, bm25(units_fts) AS rank, substr(units.text, 1, 240) AS snippet
         FROM units_fts
         JOIN units ON units.evidence_id = units_fts.evidence_id
         WHERE units_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      : `SELECT units.evidence_id AS evidenceId, units.path AS path, units.symbol_id AS symbolId,
                units.language AS language, bm25(units_fts) AS rank, substr(units.text, 1, 240) AS snippet
         FROM units_fts
         JOIN units ON units.evidence_id = units_fts.evidence_id
         WHERE units_fts MATCH ? AND units.language = ?
         ORDER BY rank
         LIMIT ?`;
  const rows =
    language === undefined
      ? (db.prepare(sql).all(match, limit) as SearchHit[])
      : (db.prepare(sql).all(match, language, limit) as SearchHit[]);
  return rows.map((row) => ({
    evidenceId: row.evidenceId,
    path: row.path,
    symbolId: row.symbolId,
    language: row.language,
    rank: row.rank,
    snippet: row.snippet,
  }));
}
