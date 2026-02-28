import { describe, expect, it } from "vitest";
import { extractReferenceData } from "@journal-reader/parser";

describe("extractReferenceData", () => {
  it("extracts discontinuous and ranged in-text markers plus reference entries", () => {
    const spans = [
      {
        text: "Model performance was strong",
        page: 1,
        bbox: { x: 10, y: 700, w: 220, h: 16 },
      },
      {
        text: "16,17,21,23",
        page: 1,
        bbox: { x: 234, y: 706, w: 64, h: 11 },
      },
      {
        text: "and robust under perturbation",
        page: 1,
        bbox: { x: 302, y: 700, w: 210, h: 16 },
      },
      {
        text: "See also [2, 4-5] for controls.",
        page: 1,
        bbox: { x: 10, y: 678, w: 230, h: 16 },
      },
      {
        text: "References",
        page: 2,
        bbox: { x: 10, y: 760, w: 100, h: 18 },
      },
      {
        text: "16. Alpha et al. First paper.",
        page: 2,
        bbox: { x: 10, y: 734, w: 260, h: 15 },
      },
      {
        text: "17. Beta et al. Second paper.",
        page: 2,
        bbox: { x: 10, y: 716, w: 260, h: 15 },
      },
      {
        text: "21. Gamma et al. Third paper.",
        page: 2,
        bbox: { x: 10, y: 698, w: 260, h: 15 },
      },
      {
        text: "23. Delta et al. Fourth paper.",
        page: 2,
        bbox: { x: 10, y: 680, w: 260, h: 15 },
      },
      {
        text: "[2] Basic reference entry.",
        page: 2,
        bbox: { x: 10, y: 662, w: 240, h: 15 },
      },
      {
        text: "[4] Another entry",
        page: 2,
        bbox: { x: 10, y: 644, w: 240, h: 15 },
      },
      {
        text: "continued line for [4].",
        page: 2,
        bbox: { x: 10, y: 628, w: 240, h: 15 },
      },
      {
        text: "[5] Last entry.",
        page: 2,
        bbox: { x: 10, y: 612, w: 240, h: 15 },
      },
    ];

    const out = extractReferenceData(spans, "doc-ref");
    expect(out.markers.some((marker) => marker.indices.join(",") === "16,17,21,23")).toBe(true);
    expect(out.markers.some((marker) => marker.indices.join(",") === "2,4,5")).toBe(true);
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([2, 4, 5, 16, 17, 21, 23]));
    const entry4 = out.entries.find((entry) => entry.index === 4);
    expect(entry4?.text).toContain("continued line");
  });

  it("parses superscript-like token even when trailing punctuation exists", () => {
    const spans = [
      {
        text: "Signal improves strongly",
        page: 1,
        bbox: { x: 10, y: 700, w: 170, h: 16 },
      },
      {
        text: "16,17,21,23.",
        page: 1,
        bbox: { x: 184, y: 706, w: 70, h: 11 },
      },
    ];

    const out = extractReferenceData(spans, "doc-ref2");
    expect(out.markers.some((marker) => marker.indices.join(",") === "16,17,21,23")).toBe(true);
  });

  it("falls back to tail candidate references when no explicit header exists", () => {
    const spans = [
      { text: "Discussion paragraph without references header.", page: 6, bbox: { x: 10, y: 500, w: 320, h: 14 } },
      { text: "1. Smith et al. First entry.", page: 10, bbox: { x: 10, y: 740, w: 220, h: 14 } },
      { text: "2. Doe et al. Second entry.", page: 10, bbox: { x: 10, y: 722, w: 220, h: 14 } },
      { text: "3. Roe et al. Third entry.", page: 10, bbox: { x: 10, y: 704, w: 220, h: 14 } },
      { text: "4. Poe et al. Fourth entry.", page: 10, bbox: { x: 10, y: 686, w: 220, h: 14 } },
    ];

    const out = extractReferenceData(spans, "doc-ref3");
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });

  it("accepts near-start prefixed numbering and ignores implausible year-like indices", () => {
    const spans = [
      { text: "References", page: 2, bbox: { x: 10, y: 760, w: 120, h: 18 } },
      { text: "- 16. Movva et al. Deciphering regulatory DNA.", page: 2, bbox: { x: 300, y: 734, w: 280, h: 14 } },
      { text: "17. de Almeida et al. DeepSTARR predicts enhancer activity.", page: 2, bbox: { x: 300, y: 716, w: 300, h: 14 } },
      { text: "2022. Identified proteins were filtered for contaminants.", page: 3, bbox: { x: 40, y: 740, w: 340, h: 14 } },
    ];

    const out = extractReferenceData(spans, "doc-ref4");
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([16, 17]));
    expect(out.entries.some((entry) => entry.index === 2022)).toBe(false);
  });
});
