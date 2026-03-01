import { describe, expect, it } from "vitest";
import { mapCitationsToTargets } from "@journal-reader/parser";

describe("mapCitationsToTargets", () => {
  it("maps citations to closest caption target", () => {
    const citations = [
      {
        id: "c1",
        docId: "doc1",
        page: 2,
        text: "Fig. 2",
        kind: "figure" as const,
        label: "2",
        bbox: { x: 10, y: 10, w: 30, h: 10 },
      },
    ];

    const captions = [
      {
        kind: "figure" as const,
        label: "2",
        caption: "Figure 2: model overview",
        page: 3,
        bbox: { x: 80, y: 300, w: 140, h: 18 },
      },
    ];

    const out = mapCitationsToTargets("doc1", citations, captions);
    expect(out.targets).toHaveLength(1);
    expect(out.citationsToTarget.get("c1")).toBe(out.targets[0].id);
    expect(out.targets[0]).toMatchObject({ kind: "figure", label: "2", source: "auto" });
    expect(out.targets[0]?.cropRect.y).toBeGreaterThan(captions[0]!.bbox.y);
    expect(out.unresolvedCitationIds).toHaveLength(0);
  });

  it("falls back subfigure label (1A -> 1) when exact caption label is missing", () => {
    const citations = [
      {
        id: "c-sub",
        docId: "doc2",
        page: 2,
        text: "Fig. 1a",
        kind: "figure" as const,
        label: "1A",
        bbox: { x: 10, y: 10, w: 30, h: 10 },
      },
    ];

    const captions = [
      {
        kind: "figure" as const,
        label: "1",
        caption: "Fig. 1: Main overview",
        page: 3,
        bbox: { x: 60, y: 260, w: 200, h: 18 },
        quality: 1,
      },
    ];

    const out = mapCitationsToTargets("doc2", citations, captions);
    expect(out.targets).toHaveLength(1);
    expect(out.targets[0]?.label).toBe("1");
    expect(out.citationsToTarget.get("c-sub")).toBe(out.targets[0]?.id);
  });

  it("prefers base caption for subfigure citation when both exact and base exist", () => {
    const citations = [
      {
        id: "c-sub-both",
        docId: "doc3",
        page: 2,
        text: "Fig. 1a",
        kind: "figure" as const,
        label: "1A",
        bbox: { x: 14, y: 20, w: 34, h: 10 },
      },
    ];

    const captions = [
      {
        kind: "figure" as const,
        label: "1A",
        caption: "Fig. 1A: inline mention style false positive",
        page: 2,
        bbox: { x: 100, y: 200, w: 220, h: 16 },
        quality: 0.8,
      },
      {
        kind: "figure" as const,
        label: "1",
        caption: "Fig. 1: whole figure caption",
        page: 5,
        bbox: { x: 70, y: 260, w: 260, h: 20 },
        quality: 1,
      },
    ];

    const out = mapCitationsToTargets("doc3", citations, captions);
    expect(out.targets.length).toBeGreaterThanOrEqual(1);
    const mappedId = out.citationsToTarget.get("c-sub-both");
    const mapped = out.targets.find((item) => item.id === mappedId);
    expect(mapped?.label).toBe("1");
  });
});
