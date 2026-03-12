import Database from "better-sqlite3";

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS documents (
      doc_id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS citations (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      bbox_json TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visual_targets (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      page INTEGER NOT NULL,
      caption_page INTEGER,
      crop_rect_json TEXT NOT NULL,
      caption_rect_json TEXT,
      caption TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS citation_target_map (
      citation_id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(citation_id) REFERENCES citations(id) ON DELETE CASCADE,
      FOREIGN KEY(target_id) REFERENCES visual_targets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL,
      rects_json TEXT NOT NULL,
      text TEXT,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reference_markers (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      indices_json TEXT NOT NULL,
      bbox_json TEXT NOT NULL,
      FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reference_entries (
      doc_id TEXT NOT NULL,
      ref_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      page INTEGER NOT NULL,
      PRIMARY KEY(doc_id, ref_index),
      FOREIGN KEY(doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_citations_doc_page ON citations(doc_id, page);
    CREATE INDEX IF NOT EXISTS idx_targets_doc_kind_label ON visual_targets(doc_id, kind, label);
    CREATE INDEX IF NOT EXISTS idx_annotations_doc_page ON annotations(doc_id, page);
    CREATE INDEX IF NOT EXISTS idx_ref_markers_doc_page ON reference_markers(doc_id, page);
  `);

  const columns = db
    .prepare("PRAGMA table_info(visual_targets)")
    .all() as Array<{ name: string }>;
  const hasCaptionRect = columns.some((col) => col.name === "caption_rect_json");
  if (!hasCaptionRect) {
    db.exec("ALTER TABLE visual_targets ADD COLUMN caption_rect_json TEXT");
  }
  const hasCaptionPage = columns.some((col) => col.name === "caption_page");
  if (!hasCaptionPage) {
    db.exec("ALTER TABLE visual_targets ADD COLUMN caption_page INTEGER");
  }
}
