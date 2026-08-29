import { embedText, embeddingJson } from "./embedder.js";
import type { SearchHit } from "../ingestion/types.js";
import { INDEX_TOOLCHAIN } from "../ingestion/types.js";
import type { SqliteDatabase } from "../index-db.js";

export function insertUnitVector(db: SqliteDatabase, rowid: number, text: string, language: string): void {
  const vector = embedText(text);
  db.prepare("INSERT INTO units_vec(rowid, embedding, language) VALUES (?, ?, ?)").run(
    BigInt(rowid),
    embeddingJson(vector),
    language,
  );
}

export function reembedAllVectors(db: SqliteDatabase): void {
  db.exec("DROP TABLE IF EXISTS units_vec;");
  db.exec(
    `CREATE VIRTUAL TABLE units_vec USING vec0(
      embedding float[${String(INDEX_TOOLCHAIN.vectorDimensions)}],
      language TEXT
    );`,
  );
  const rows = db.prepare("SELECT id AS id, text AS text, language AS language FROM units").all() as {
    id: number;
    text: string;
    language: string;
  }[];
  for (const row of rows) {
    insertUnitVector(db, Number(row.id), row.text, row.language);
  }
}

export function searchVector(
  db: SqliteDatabase,
  query: string,
  options: { k?: number; language?: string } = {},
): SearchHit[] {
  const k = options.k ?? 10;
  const vector = embeddingJson(embedText(query));
  const language = options.language;
  const sql =
    language === undefined
      ? `SELECT units.evidence_id AS evidenceId, units.path AS path, units.symbol_id AS symbolId,
                units.language AS language, units_vec.distance AS rank, substr(units.text, 1, 240) AS snippet
         FROM units_vec
         JOIN units ON units.id = units_vec.rowid
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      : `SELECT units.evidence_id AS evidenceId, units.path AS path, units.symbol_id AS symbolId,
                units.language AS language, units_vec.distance AS rank, substr(units.text, 1, 240) AS snippet
         FROM units_vec
         JOIN units ON units.id = units_vec.rowid
         WHERE embedding MATCH ? AND k = ? AND units_vec.language = ?
         ORDER BY distance`;
  const rows =
    language === undefined
      ? (db.prepare(sql).all(vector, k) as SearchHit[])
      : (db.prepare(sql).all(vector, k, language) as SearchHit[]);
  return rows.map((row) => ({
    evidenceId: row.evidenceId,
    path: row.path,
    symbolId: row.symbolId,
    language: row.language,
    rank: row.rank,
    snippet: row.snippet,
  }));
}
