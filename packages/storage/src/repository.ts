import { randomUUID, createHash } from "node:crypto";
import { dirname, basename } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  AnnotationItem,
  CitationRef,
  InTextReferenceMarker,
  Rect,
  ResolveCitationResponse,
  ResolveReferenceResponse,
  ReferenceEntry,
  TargetKind,
  VisualTarget,
} from "@journal-reader/types";
import { ensureSchema } from "./schema.js";

type CitationRow = {
  id: string;
  doc_id: string;
  page: number;
  text: string;
  kind: TargetKind;
  label: string;
  bbox_json: string;
};

type VisualTargetRow = {
  id: string;
  doc_id: string;
  kind: TargetKind;
  label: string;
  page: number;
  crop_rect_json: string;
  caption_rect_json: string | null;
  caption: string;
  confidence: number;
  source: "auto" | "manual";
};

type ReferenceMarkerRow = {
  id: string;
  doc_id: string;
  page: number;
  text: string;
  indices_json: string;
  bbox_json: string;
};

type ReferenceEntryRow = {
  doc_id: string;
  ref_index: number;
  text: string;
  page: number;
};

function toIsoNow(): string {
  return new Date().toISOString();
}

function stableDocId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 24);
}

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function baseLabel(label: string): string {
  const normalized = normalizeLabel(label);
  const match = normalized.match(/^(S?\d+)/);
  return match ? match[1] : normalized;
}

function normalizeRefSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractReferenceYears(text: string): string[] {
  return [...text.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => match[0]).filter((item): item is string => !!item);
}

function extractReferenceSurnames(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /([A-Z][A-Za-z'’\-]{1,40})\s+et\s+al\./g,
    /([A-Z][A-Za-z'’\-]{1,40})\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]{1,40}/g,
    /([A-Z][A-Za-z'’\-]{1,40}),\s*\b(?:19|20)\d{2}\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const surname = match[1]?.toLowerCase();
      if (surname && surname.length >= 2) {
        out.add(surname);
      }
    }
  }
  return [...out];
}

export class StorageRepository {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    ensureSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  openDocument(path: string, pageCount: number, title?: string): { docId: string; pageCount: number; title: string } {
    const docId = stableDocId(path);
    const now = toIsoNow();
    const realTitle = title ?? basename(path);

    this.db
      .prepare(
        `INSERT INTO documents (doc_id, path, title, page_count, created_at, updated_at)
         VALUES (@doc_id, @path, @title, @page_count, @created_at, @updated_at)
         ON CONFLICT(doc_id) DO UPDATE SET
           title=excluded.title,
           page_count=excluded.page_count,
           updated_at=excluded.updated_at`,
      )
      .run({
        doc_id: docId,
        path,
        title: realTitle,
        page_count: pageCount,
        created_at: now,
        updated_at: now,
      });

    return { docId, pageCount, title: realTitle };
  }

  getDocumentPath(docId: string): string | null {
    const row = this.db.prepare("SELECT path FROM documents WHERE doc_id = ?").get(docId) as { path: string } | undefined;
    return row?.path ?? null;
  }

  replaceCitations(docId: string, citations: CitationRef[]): void {
    const delStmt = this.db.prepare("DELETE FROM citations WHERE doc_id = ?");
    const insertStmt = this.db.prepare(
      `INSERT INTO citations (id, doc_id, page, text, kind, label, bbox_json)
       VALUES (@id, @doc_id, @page, @text, @kind, @label, @bbox_json)`,
    );

    const tx = this.db.transaction(() => {
      delStmt.run(docId);
      for (const citation of citations) {
        insertStmt.run({
          id: citation.id,
          doc_id: citation.docId,
          page: citation.page,
          text: citation.text,
          kind: citation.kind,
          label: citation.label,
          bbox_json: JSON.stringify(citation.bbox),
        });
      }
    });

    tx();
  }

  replaceReferences(docId: string, markers: InTextReferenceMarker[], entries: ReferenceEntry[]): void {
    const delMarkers = this.db.prepare("DELETE FROM reference_markers WHERE doc_id = ?");
    const delEntries = this.db.prepare("DELETE FROM reference_entries WHERE doc_id = ?");
    const insertMarker = this.db.prepare(
      `INSERT INTO reference_markers (id, doc_id, page, text, indices_json, bbox_json)
       VALUES (@id, @doc_id, @page, @text, @indices_json, @bbox_json)`,
    );
    const insertEntry = this.db.prepare(
      `INSERT INTO reference_entries (doc_id, ref_index, text, page)
       VALUES (@doc_id, @ref_index, @text, @page)
       ON CONFLICT(doc_id, ref_index) DO UPDATE SET
         text=excluded.text,
         page=excluded.page`,
    );

    const tx = this.db.transaction(() => {
      delMarkers.run(docId);
      delEntries.run(docId);
      for (const marker of markers) {
        insertMarker.run({
          id: marker.id,
          doc_id: docId,
          page: marker.page,
          text: marker.text,
          indices_json: JSON.stringify(marker.indices),
          bbox_json: JSON.stringify(marker.bbox),
        });
      }

      for (const entry of entries) {
        insertEntry.run({
          doc_id: docId,
          ref_index: entry.index,
          text: entry.text,
          page: entry.page,
        });
      }
    });

    tx();
  }

  replaceAutoTargets(docId: string, targets: VisualTarget[]): void {
    const delStmt = this.db.prepare("DELETE FROM visual_targets WHERE doc_id = ? AND source = 'auto'");
    const insertStmt = this.db.prepare(
      `INSERT INTO visual_targets (id, doc_id, kind, label, page, crop_rect_json, caption_rect_json, caption, confidence, source)
       VALUES (@id, @doc_id, @kind, @label, @page, @crop_rect_json, @caption_rect_json, @caption, @confidence, @source)
       ON CONFLICT(id) DO UPDATE SET
         crop_rect_json=excluded.crop_rect_json,
         caption_rect_json=excluded.caption_rect_json,
         caption=excluded.caption,
         confidence=excluded.confidence`,
    );

    const tx = this.db.transaction(() => {
      delStmt.run(docId);
      for (const target of targets.filter((item) => item.source === "auto")) {
        insertStmt.run({
          id: target.id,
          doc_id: target.docId,
          kind: target.kind,
          label: target.label,
          page: target.page,
          crop_rect_json: JSON.stringify(target.cropRect),
          caption_rect_json: target.captionRect ? JSON.stringify(target.captionRect) : null,
          caption: target.caption,
          confidence: target.confidence,
          source: target.source,
        });
      }
    });

    tx();
  }

  listManualTargets(docId: string): VisualTarget[] {
    const rows = this.db
      .prepare("SELECT * FROM visual_targets WHERE doc_id = ? AND source = 'manual'")
      .all(docId) as VisualTargetRow[];

    return rows.map((row) => ({
      id: row.id,
      docId: row.doc_id,
      kind: row.kind,
      label: row.label,
      page: row.page,
      cropRect: JSON.parse(row.crop_rect_json) as Rect,
      captionRect: row.caption_rect_json ? (JSON.parse(row.caption_rect_json) as Rect) : undefined,
      caption: row.caption,
      confidence: row.confidence,
      source: row.source,
    }));
  }

  listAllTargets(docId: string): VisualTarget[] {
    const rows = this.db.prepare("SELECT * FROM visual_targets WHERE doc_id = ?").all(docId) as VisualTargetRow[];
    return rows.map((row) => ({
      id: row.id,
      docId: row.doc_id,
      kind: row.kind,
      label: row.label,
      page: row.page,
      cropRect: JSON.parse(row.crop_rect_json) as Rect,
      captionRect: row.caption_rect_json ? (JSON.parse(row.caption_rect_json) as Rect) : undefined,
      caption: row.caption,
      confidence: row.confidence,
      source: row.source,
    }));
  }

  upsertTargets(targets: VisualTarget[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO visual_targets (id, doc_id, kind, label, page, crop_rect_json, caption_rect_json, caption, confidence, source)
       VALUES (@id, @doc_id, @kind, @label, @page, @crop_rect_json, @caption_rect_json, @caption, @confidence, @source)
       ON CONFLICT(id) DO UPDATE SET
         crop_rect_json=excluded.crop_rect_json,
         caption_rect_json=excluded.caption_rect_json,
         caption=excluded.caption,
         confidence=excluded.confidence,
         source=excluded.source`,
    );

    for (const target of targets) {
      stmt.run({
        id: target.id,
        doc_id: target.docId,
        kind: target.kind,
        label: target.label,
        page: target.page,
        crop_rect_json: JSON.stringify(target.cropRect),
        caption_rect_json: target.captionRect ? JSON.stringify(target.captionRect) : null,
        caption: target.caption,
        confidence: target.confidence,
        source: target.source,
      });
    }
  }

  replaceCitationMappings(mappings: Map<string, string>): void {
    const insertStmt = this.db.prepare(
      `INSERT INTO citation_target_map (citation_id, target_id, updated_at)
       VALUES (@citation_id, @target_id, @updated_at)
       ON CONFLICT(citation_id) DO UPDATE SET
         target_id=excluded.target_id,
         updated_at=excluded.updated_at`,
    );

    for (const [citationId, targetId] of mappings.entries()) {
      insertStmt.run({ citation_id: citationId, target_id: targetId, updated_at: toIsoNow() });
    }
  }

  resolveCitationAtPoint(docId: string, page: number, x: number, y: number): ResolveCitationResponse | null {
    const citation = this.db
      .prepare(
        `SELECT c.*, m.target_id
         FROM citations c
         LEFT JOIN citation_target_map m ON m.citation_id = c.id
         WHERE c.doc_id = @doc_id
           AND c.page = @page`,
      )
      .all({ doc_id: docId, page }) as (CitationRow & { target_id: string | null })[];

    const hitPadding = 3;
    const hits = citation
      .map((row) => {
        const bbox = JSON.parse(row.bbox_json) as Rect;
        const inside =
          x >= bbox.x - hitPadding &&
          x <= bbox.x + bbox.w + hitPadding &&
          y >= bbox.y - hitPadding &&
          y <= bbox.y + bbox.h + hitPadding;
        if (!inside) {
          return null;
        }

        const centerX = bbox.x + bbox.w / 2;
        const centerY = bbox.y + bbox.h / 2;
        return {
          row,
          mapped: row.target_id ? 1 : 0,
          area: Math.max(1, bbox.w * bbox.h),
          distance: Math.hypot(x - centerX, y - centerY),
        };
      })
      .filter(
        (
          item,
        ): item is {
          row: CitationRow & { target_id: string | null };
          mapped: number;
          area: number;
          distance: number;
        } => !!item,
      )
      .sort((a, b) => {
        if (a.mapped !== b.mapped) {
          return b.mapped - a.mapped;
        }
        if (a.area !== b.area) {
          return a.area - b.area;
        }
        return a.distance - b.distance;
      });

    const winner = hits[0]?.row;
    if (!winner) {
      return null;
    }

    return {
      targetId: winner.target_id,
      kind: winner.kind,
      label: winner.label,
      citationId: winner.id,
    };
  }

  resolveCitationByKindLabel(docId: string, kind: TargetKind, label: string): ResolveCitationResponse | null {
    const normalized = normalizeLabel(label);
    const base = baseLabel(normalized);

    const citationRows = this.db
      .prepare(
        `SELECT c.*, m.target_id
         FROM citations c
         LEFT JOIN citation_target_map m ON m.citation_id = c.id
         WHERE c.doc_id = @doc_id
           AND c.kind = @kind
           AND UPPER(c.label) = @label`,
      )
      .all({ doc_id: docId, kind, label: normalized }) as (CitationRow & { target_id: string | null })[];

    const chosenCitation =
      citationRows.sort((a, b) => {
        const aMapped = a.target_id ? 1 : 0;
        const bMapped = b.target_id ? 1 : 0;
        return bMapped - aMapped;
      })[0] ?? null;

    if (chosenCitation?.target_id) {
      return {
        targetId: chosenCitation.target_id,
        kind,
        label: chosenCitation.label,
        citationId: chosenCitation.id,
      };
    }

    const targetRows = this.db
      .prepare(
        `SELECT id, label, source, confidence
         FROM visual_targets
         WHERE doc_id = @doc_id
           AND kind = @kind`,
      )
      .all({ doc_id: docId, kind }) as Array<{ id: string; label: string; source: "auto" | "manual"; confidence: number }>;

    const exactTarget =
      targetRows
        .filter((row) => normalizeLabel(row.label) === normalized)
        .sort((a, b) => {
          const aManual = a.source === "manual" ? 1 : 0;
          const bManual = b.source === "manual" ? 1 : 0;
          if (aManual !== bManual) {
            return bManual - aManual;
          }
          return b.confidence - a.confidence;
        })[0] ?? null;

    if (exactTarget) {
      return {
        targetId: exactTarget.id,
        kind,
        label: normalized,
      };
    }

    const baseTarget =
      targetRows
        .filter((row) => baseLabel(row.label) === base)
        .sort((a, b) => {
          const aManual = a.source === "manual" ? 1 : 0;
          const bManual = b.source === "manual" ? 1 : 0;
          if (aManual !== bManual) {
            return bManual - aManual;
          }
          return b.confidence - a.confidence;
        })[0] ?? null;

    if (baseTarget) {
      return {
        targetId: baseTarget.id,
        kind,
        label: normalized,
      };
    }

    if (chosenCitation) {
      return {
        targetId: null,
        kind,
        label: chosenCitation.label,
        citationId: chosenCitation.id,
      };
    }

    return null;
  }

  resolveReferenceAtPoint(docId: string, page: number, x: number, y: number): ResolveReferenceResponse | null {
    const rows = this.db
      .prepare("SELECT * FROM reference_markers WHERE doc_id = ? AND page = ?")
      .all(docId, page) as ReferenceMarkerRow[];

    const hitPadding = 10;
    const hits = rows
      .map((row) => {
        const bbox = JSON.parse(row.bbox_json) as Rect;
        const inside =
          x >= bbox.x - hitPadding &&
          x <= bbox.x + bbox.w + hitPadding &&
          y >= bbox.y - hitPadding &&
          y <= bbox.y + bbox.h + hitPadding;
        if (!inside) {
          return null;
        }

        const centerX = bbox.x + bbox.w / 2;
        const centerY = bbox.y + bbox.h / 2;
        return {
          row,
          area: Math.max(1, bbox.w * bbox.h),
          distance: Math.hypot(x - centerX, y - centerY),
        };
      })
      .filter(
        (
          item,
        ): item is {
          row: ReferenceMarkerRow;
          area: number;
          distance: number;
        } => !!item,
      )
      .sort((a, b) => {
        if (a.area !== b.area) {
          return a.area - b.area;
        }
        return a.distance - b.distance;
      });

    const winner = hits[0]?.row;
    if (!winner) {
      return null;
    }

    return {
      markerId: winner.id,
      indices: JSON.parse(winner.indices_json) as number[],
    };
  }

  getReferenceEntries(docId: string, indices: number[]): ReferenceEntry[] {
    if (indices.length === 0) {
      return [];
    }

    const uniq = [...new Set(indices.filter((value) => Number.isFinite(value) && value > 0))];
    if (uniq.length === 0) {
      return [];
    }

    const placeholders = uniq.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT doc_id, ref_index, text, page
         FROM reference_entries
         WHERE doc_id = ?
           AND ref_index IN (${placeholders})
         ORDER BY ref_index ASC`,
      )
      .all(docId, ...uniq) as ReferenceEntryRow[];

    return rows.map((row) => ({
      docId: row.doc_id,
      index: row.ref_index,
      text: row.text,
      page: row.page,
    }));
  }

  searchReferenceEntries(docId: string, rawQuery: string, limit = 12): ReferenceEntry[] {
    const query = normalizeRefSnippet(rawQuery);
    if (!query) {
      return [];
    }
    const years = extractReferenceYears(query);
    const surnames = extractReferenceSurnames(query);
    const fallbackTokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4)
      .slice(0, 8);

    const rows = this.db
      .prepare(
        `SELECT doc_id, ref_index, text, page
         FROM reference_entries
         WHERE doc_id = ?
         ORDER BY ref_index ASC`,
      )
      .all(docId) as ReferenceEntryRow[];

    const scored = rows
      .map((row) => {
        const lower = row.text.toLowerCase();
        let score = 0;
        for (const year of years) {
          if (lower.includes(year)) {
            score += 12;
          }
        }
        for (const surname of surnames) {
          if (new RegExp(`\\b${surname},`, "i").test(row.text)) {
            score += 10;
            continue;
          }
          if (new RegExp(`\\b${surname}\\b`, "i").test(row.text)) {
            score += 6;
          }
        }
        if (score === 0 && years.length === 0 && surnames.length === 0) {
          for (const token of fallbackTokens) {
            if (lower.includes(token)) {
              score += 1;
            }
          }
        }
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.row.ref_index - b.row.ref_index;
      })
      .slice(0, Math.max(1, Math.min(30, limit)));

    return scored.map(({ row }) => ({
      docId: row.doc_id,
      index: row.ref_index,
      text: row.text,
      page: row.page,
    }));
  }

  hasReferenceEntries(docId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM reference_entries WHERE doc_id = ?").get(docId) as { n: number };
    return row.n > 0;
  }

  listAllReferenceEntries(docId: string): ReferenceEntry[] {
    const rows = this.db
      .prepare(
        `SELECT doc_id, ref_index, text, page
         FROM reference_entries
         WHERE doc_id = ?
         ORDER BY ref_index ASC`,
      )
      .all(docId) as ReferenceEntryRow[];
    return rows.map((row) => ({
      docId: row.doc_id,
      index: row.ref_index,
      text: row.text,
      page: row.page,
    }));
  }

  getTarget(docId: string, targetId: string): VisualTarget | null {
    const row = this.db
      .prepare("SELECT * FROM visual_targets WHERE doc_id = ? AND id = ?")
      .get(docId, targetId) as VisualTargetRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      docId: row.doc_id,
      kind: row.kind,
      label: row.label,
      page: row.page,
      cropRect: JSON.parse(row.crop_rect_json) as Rect,
      captionRect: row.caption_rect_json ? (JSON.parse(row.caption_rect_json) as Rect) : undefined,
      caption: row.caption,
      confidence: row.confidence,
      source: row.source,
    };
  }

  listTargetsByKindLabel(docId: string, kind: TargetKind, label: string): VisualTarget[] {
    const normalized = normalizeLabel(label);
    const base = baseLabel(normalized);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM visual_targets
         WHERE doc_id = @doc_id
           AND kind = @kind`,
      )
      .all({ doc_id: docId, kind }) as VisualTargetRow[];

    const candidates = rows.filter((row) => {
      const rowLabel = normalizeLabel(row.label);
      if (rowLabel === normalized) {
        return true;
      }
      return baseLabel(rowLabel) === base;
    });

    return candidates
      .map((row) => ({
        id: row.id,
        docId: row.doc_id,
        kind: row.kind,
        label: row.label,
        page: row.page,
        cropRect: JSON.parse(row.crop_rect_json) as Rect,
        captionRect: row.caption_rect_json ? (JSON.parse(row.caption_rect_json) as Rect) : undefined,
        caption: row.caption,
        confidence: row.confidence,
        source: row.source,
      }))
      .sort((a, b) => {
        const aExact = normalizeLabel(a.label) === normalized ? 1 : 0;
        const bExact = normalizeLabel(b.label) === normalized ? 1 : 0;
        if (aExact !== bExact) {
          return bExact - aExact;
        }
        const aManual = a.source === "manual" ? 1 : 0;
        const bManual = b.source === "manual" ? 1 : 0;
        if (aManual !== bManual) {
          return bManual - aManual;
        }
        return b.confidence - a.confidence;
      });
  }

  listTargetsByKind(docId: string, kind: TargetKind): VisualTarget[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM visual_targets
         WHERE doc_id = ?
           AND kind = ?
         ORDER BY page ASC, label ASC, confidence DESC`,
      )
      .all(docId, kind) as VisualTargetRow[];
    return rows.map((row) => ({
      id: row.id,
      docId: row.doc_id,
      kind: row.kind,
      label: row.label,
      page: row.page,
      cropRect: JSON.parse(row.crop_rect_json) as Rect,
      captionRect: row.caption_rect_json ? (JSON.parse(row.caption_rect_json) as Rect) : undefined,
      caption: row.caption,
      confidence: row.confidence,
      source: row.source,
    }));
  }

  createAnnotation(
    payload: Omit<AnnotationItem, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): AnnotationItem {
    const id = payload.id ?? randomUUID();
    const now = toIsoNow();
    const row: AnnotationItem = {
      ...payload,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO annotations (id, doc_id, page, kind, rects_json, text, color, created_at, updated_at)
         VALUES (@id, @doc_id, @page, @kind, @rects_json, @text, @color, @created_at, @updated_at)`,
      )
      .run({
        id: row.id,
        doc_id: row.docId,
        page: row.page,
        kind: row.kind,
        rects_json: JSON.stringify(row.rects),
        text: row.text ?? null,
        color: row.color ?? null,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });

    return row;
  }

  updateAnnotation(
    payload: Partial<Omit<AnnotationItem, "createdAt" | "updatedAt">> & { id: string },
  ): AnnotationItem | null {
    const current = this.db
      .prepare("SELECT * FROM annotations WHERE id = ?")
      .get(payload.id) as
      | {
          id: string;
          doc_id: string;
          page: number;
          kind: AnnotationItem["kind"];
          rects_json: string;
          text: string | null;
          color: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!current) {
      return null;
    }

    const merged: AnnotationItem = {
      id: current.id,
      docId: payload.docId ?? current.doc_id,
      page: payload.page ?? current.page,
      kind: payload.kind ?? current.kind,
      rects: payload.rects ?? (JSON.parse(current.rects_json) as Rect[]),
      text: payload.text ?? current.text ?? undefined,
      color: payload.color ?? current.color ?? undefined,
      createdAt: current.created_at,
      updatedAt: toIsoNow(),
    };

    this.db
      .prepare(
        `UPDATE annotations
         SET doc_id=@doc_id, page=@page, kind=@kind, rects_json=@rects_json, text=@text, color=@color, updated_at=@updated_at
         WHERE id=@id`,
      )
      .run({
        id: merged.id,
        doc_id: merged.docId,
        page: merged.page,
        kind: merged.kind,
        rects_json: JSON.stringify(merged.rects),
        text: merged.text ?? null,
        color: merged.color ?? null,
        updated_at: merged.updatedAt,
      });

    return merged;
  }

  deleteAnnotation(id: string): boolean {
    const result = this.db.prepare("DELETE FROM annotations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getAnnotationDocId(id: string): string | null {
    const row = this.db.prepare("SELECT doc_id FROM annotations WHERE id = ?").get(id) as { doc_id: string } | undefined;
    return row?.doc_id ?? null;
  }

  listAnnotations(docId: string): AnnotationItem[] {
    const rows = this.db.prepare("SELECT * FROM annotations WHERE doc_id = ? ORDER BY created_at ASC").all(docId) as Array<{
      id: string;
      doc_id: string;
      page: number;
      kind: AnnotationItem["kind"];
      rects_json: string;
      text: string | null;
      color: string | null;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      docId: row.doc_id,
      page: row.page,
      kind: row.kind,
      rects: JSON.parse(row.rects_json) as Rect[],
      text: row.text ?? undefined,
      color: row.color ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  bindManualTarget(
    docId: string,
    citationId: string,
    targetRect: Rect,
    captionText: string,
    targetPage?: number,
  ): { ok: boolean; targetId: string } {
    const citation = this.db
      .prepare("SELECT kind, label, page FROM citations WHERE id = ? AND doc_id = ?")
      .get(citationId, docId) as { kind: TargetKind; label: string; page: number } | undefined;

    if (!citation) {
      throw new Error(`citation ${citationId} not found in doc ${docId}`);
    }

    const targetId = randomUUID();
    const target: VisualTarget = {
      id: targetId,
      docId,
      kind: citation.kind,
      label: citation.label,
      page: targetPage ?? citation.page,
      cropRect: targetRect,
      caption: captionText,
      confidence: 1,
      source: "manual",
    };

    const tx = this.db.transaction(() => {
      this.upsertTargets([target]);
      this.replaceCitationMappings(new Map([[citationId, targetId]]));
    });

    tx();
    return { ok: true, targetId };
  }

  stats(docId: string): {
    refsCount: number;
    figuresCount: number;
    tablesCount: number;
    suppCount: number;
  } {
    const refsCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM reference_entries WHERE doc_id = ?").get(docId) as { n: number }
    ).n;
    const figuresCount = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM visual_targets WHERE doc_id = ? AND kind = 'figure'")
        .get(docId) as { n: number }
    ).n;
    const tablesCount = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM visual_targets WHERE doc_id = ? AND kind = 'table'")
        .get(docId) as { n: number }
    ).n;
    const suppCount = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM visual_targets WHERE doc_id = ? AND kind = 'supplementary'")
        .get(docId) as { n: number }
    ).n;

    return {
      refsCount,
      figuresCount,
      tablesCount,
      suppCount,
    };
  }
}
