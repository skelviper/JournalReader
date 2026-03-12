import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { StorageRepository } from "@journal-reader/storage";

describe("StorageRepository", () => {
  let root = "";
  let repo: StorageRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jr-test-"));
    repo = new StorageRepository(join(root, "reader.db"));
  });

  afterEach(() => {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates/updates annotations and resolves citations", () => {
    const opened = repo.openDocument("/tmp/paper.pdf", 12, "paper.pdf");
    const citationId = "citation-1";

    repo.replaceCitations(opened.docId, [
      {
        id: citationId,
        docId: opened.docId,
        page: 1,
        text: "Fig. 1",
        kind: "figure",
        label: "1",
        bbox: { x: 10, y: 10, w: 60, h: 12 },
      },
    ]);

    repo.upsertTargets([
      {
        id: "target-1",
        docId: opened.docId,
        kind: "figure",
        label: "1",
        page: 2,
        cropRect: { x: 80, y: 120, w: 200, h: 140 },
        caption: "Figure 1: Example",
        confidence: 0.9,
        source: "auto",
      },
    ]);

    repo.replaceCitationMappings(new Map([[citationId, "target-1"]]));

    const resolved = repo.resolveCitationAtPoint(opened.docId, 1, 20, 15);
    expect(resolved).toMatchObject({ targetId: "target-1", kind: "figure", label: "1", citationId });

    const ann = repo.createAnnotation({
      docId: opened.docId,
      page: 1,
      kind: "sticky-note",
      rects: [{ x: 5, y: 6, w: 30, h: 20 }],
      text: "todo",
    });

    expect(repo.listAnnotations(opened.docId)).toHaveLength(1);

    const updated = repo.updateAnnotation({ id: ann.id, text: "updated" });
    expect(updated?.text).toBe("updated");

    const removed = repo.deleteAnnotation(ann.id);
    expect(removed).toBe(true);
    expect(repo.listAnnotations(opened.docId)).toHaveLength(0);
  });

  it("binds manual target for citation", () => {
    const opened = repo.openDocument("/tmp/paper2.pdf", 6, "paper2.pdf");

    repo.replaceCitations(opened.docId, [
      {
        id: "c-2",
        docId: opened.docId,
        page: 4,
        text: "Table 3",
        kind: "table",
        label: "3",
        bbox: { x: 12, y: 18, w: 44, h: 12 },
      },
    ]);

    const bound = repo.bindManualTarget(
      opened.docId,
      "c-2",
      { x: 80, y: 100, w: 300, h: 200 },
      "Table 3 caption",
      5,
    );
    expect(bound.ok).toBe(true);

    const resolved = repo.resolveCitationAtPoint(opened.docId, 4, 15, 20);
    expect(resolved?.targetId).toBe(bound.targetId);
    const target = repo.getTarget(opened.docId, bound.targetId);
    expect(target?.page).toBe(5);
  });

  it("prefers mapped and tighter citation hit when multiple boxes overlap", () => {
    const opened = repo.openDocument("/tmp/paper3.pdf", 4, "paper3.pdf");

    repo.replaceCitations(opened.docId, [
      {
        id: "wide",
        docId: opened.docId,
        page: 2,
        text: "Fig. 1a,b",
        kind: "figure",
        label: "1A",
        bbox: { x: 10, y: 10, w: 120, h: 18 },
      },
      {
        id: "tight",
        docId: opened.docId,
        page: 2,
        text: "Fig. 1b",
        kind: "figure",
        label: "1B",
        bbox: { x: 78, y: 10, w: 16, h: 18 },
      },
    ]);

    repo.upsertTargets([
      {
        id: "target-tight",
        docId: opened.docId,
        kind: "figure",
        label: "1",
        page: 3,
        cropRect: { x: 10, y: 10, w: 100, h: 100 },
        caption: "Figure 1",
        confidence: 0.9,
        source: "auto",
      },
    ]);
    repo.replaceCitationMappings(new Map([["tight", "target-tight"]]));

    const resolved = repo.resolveCitationAtPoint(opened.docId, 2, 82, 14);
    expect(resolved?.citationId).toBe("tight");
    expect(resolved?.targetId).toBe("target-tight");
  });

  it("resolves in-text reference markers and fetches matching entries", () => {
    const opened = repo.openDocument("/tmp/paper4.pdf", 12, "paper4.pdf");
    repo.replaceReferences(
      opened.docId,
      [
        {
          id: "m-1",
          docId: opened.docId,
          page: 3,
          text: "16,17,21,23",
          indices: [16, 17, 21, 23],
          bbox: { x: 80, y: 220, w: 42, h: 10 },
        },
      ],
      [
        { docId: opened.docId, index: 16, text: "Ref sixteen", page: 10 },
        { docId: opened.docId, index: 17, text: "Ref seventeen", page: 10 },
        { docId: opened.docId, index: 21, text: "Ref twenty-one", page: 11 },
        { docId: opened.docId, index: 23, text: "Ref twenty-three", page: 11 },
      ],
    );

    const resolved = repo.resolveReferenceAtPoint(opened.docId, 3, 82, 224);
    expect(resolved?.indices).toEqual([16, 17, 21, 23]);

    const entries = repo.getReferenceEntries(opened.docId, resolved?.indices ?? []);
    expect(entries.map((entry) => entry.index)).toEqual([16, 17, 21, 23]);
    expect(entries[0]?.text).toContain("sixteen");
    expect(repo.hasReferenceEntries(opened.docId)).toBe(true);
  });

  it("resolves figure target by kind+label with base label fallback", () => {
    const opened = repo.openDocument("/tmp/paper5.pdf", 6, "paper5.pdf");

    repo.replaceCitations(opened.docId, [
      {
        id: "c-sub",
        docId: opened.docId,
        page: 1,
        text: "Fig. 1b",
        kind: "figure",
        label: "1B",
        bbox: { x: 20, y: 20, w: 30, h: 10 },
      },
    ]);

    repo.upsertTargets([
      {
        id: "t-main",
        docId: opened.docId,
        kind: "figure",
        label: "1",
        page: 2,
        cropRect: { x: 10, y: 10, w: 120, h: 80 },
        caption: "Figure 1",
        confidence: 0.7,
        source: "auto",
      },
    ]);

    const resolved = repo.resolveCitationByKindLabel(opened.docId, "figure", "1B");
    expect(resolved?.targetId).toBe("t-main");
  });

  it("honors family hint so Fig. S1 never falls back to Table S1", () => {
    const opened = repo.openDocument("/tmp/paper6.pdf", 8, "paper6.pdf");

    repo.replaceCitations(opened.docId, [
      {
        id: "c-s1-fig",
        docId: opened.docId,
        page: 2,
        text: "Supplementary Fig. S1",
        kind: "supplementary",
        label: "S1",
        bbox: { x: 20, y: 40, w: 90, h: 12 },
      },
      {
        id: "c-s1-table",
        docId: opened.docId,
        page: 2,
        text: "Supplementary Table S1",
        kind: "supplementary",
        label: "S1",
        bbox: { x: 20, y: 60, w: 100, h: 12 },
      },
    ]);

    repo.upsertTargets([
      {
        id: "t-s1-fig",
        docId: opened.docId,
        kind: "supplementary",
        label: "S1A",
        page: 6,
        cropRect: { x: 12, y: 12, w: 200, h: 150 },
        caption: "Supplementary Fig. S1: image",
        confidence: 0.7,
        source: "auto",
      },
      {
        id: "t-s1-table",
        docId: opened.docId,
        kind: "supplementary",
        label: "S1",
        page: 7,
        cropRect: { x: 10, y: 10, w: 180, h: 120 },
        caption: "Supplementary Table S1: statistics",
        confidence: 0.9,
        source: "auto",
      },
    ]);

    const figResolved = repo.resolveCitationByKindLabel(opened.docId, "supplementary", "S1", "supplementary-figure");
    expect(figResolved?.targetId).toBe("t-s1-fig");

    const tableResolved = repo.resolveCitationByKindLabel(opened.docId, "supplementary", "S1", "supplementary-table");
    expect(tableResolved?.targetId).toBe("t-s1-table");

    const figCandidates = repo.listTargetsByKindLabel(opened.docId, "supplementary", "S1", "supplementary-figure");
    expect(figCandidates.map((item) => item.id)).toEqual(["t-s1-fig"]);

    const tableCandidates = repo.listTargetsByKindLabel(opened.docId, "supplementary", "S1", "supplementary-table");
    expect(tableCandidates.map((item) => item.id)).toEqual(["t-s1-table"]);
  });
});
