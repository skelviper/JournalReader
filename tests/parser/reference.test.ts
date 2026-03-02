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

  it("parses reference entries with leading line numbers and filters markers not in entry set", () => {
    const spans = [
      { text: "Signal remains stable", page: 1, bbox: { x: 20, y: 700, w: 180, h: 16 } },
      { text: "1603,1604", page: 1, bbox: { x: 205, y: 706, w: 64, h: 11 } },
      { text: "References", page: 2, bbox: { x: 20, y: 760, w: 120, h: 16 } },
      { text: "2101 1. Alpha et al. First entry.", page: 2, bbox: { x: 20, y: 734, w: 320, h: 14 } },
      { text: "2102 2. Beta et al. Second entry.", page: 2, bbox: { x: 20, y: 716, w: 320, h: 14 } },
      { text: "2103 3. Gamma et al. Third entry.", page: 2, bbox: { x: 20, y: 698, w: 320, h: 14 } },
      { text: "2104 4. Delta et al. Fourth entry.", page: 2, bbox: { x: 20, y: 680, w: 320, h: 14 } },
      { text: "2105 5. Epsilon et al. Fifth entry.", page: 2, bbox: { x: 20, y: 662, w: 320, h: 14 } },
      { text: "2106 6. Zeta et al. Sixth entry.", page: 2, bbox: { x: 20, y: 644, w: 320, h: 14 } },
      { text: "2107 7. Eta et al. Seventh entry.", page: 2, bbox: { x: 20, y: 626, w: 320, h: 14 } },
      { text: "2108 8. Theta et al. Eighth entry.", page: 2, bbox: { x: 20, y: 608, w: 320, h: 14 } },
      { text: "2109 9. Iota et al. Ninth entry.", page: 2, bbox: { x: 20, y: 590, w: 320, h: 14 } },
      { text: "2110 10. Kappa et al. Tenth entry.", page: 2, bbox: { x: 20, y: 572, w: 320, h: 14 } },
    ];

    const out = extractReferenceData(spans, "doc-ref5");
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(out.markers.some((marker) => marker.indices.includes(1603))).toBe(false);
  });

  it("detects references header with line-number prefix", () => {
    const spans = [
      { text: "2011 References", page: 9, bbox: { x: 16, y: 760, w: 180, h: 14 } },
      { text: "2012 1. First entry in list.", page: 9, bbox: { x: 16, y: 742, w: 260, h: 14 } },
      { text: "2013 2. Second entry in list.", page: 9, bbox: { x: 16, y: 724, w: 260, h: 14 } },
    ];

    const out = extractReferenceData(spans, "doc-ref6");
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([1, 2]));
  });

  it("filters numbered body-text noise inside references section and keeps plausible entries", () => {
    const spans = [
      { text: "References", page: 12, bbox: { x: 22, y: 760, w: 120, h: 14 } },
      {
        text: "1. 5 times the IQR, and diamond-shaped markers beyond this range indicate motifs are virtually inactive.",
        page: 12,
        bbox: { x: 22, y: 742, w: 560, h: 14 },
      },
      { text: "2. Smith, J. et al. Regulatory grammar in human promoters (2024).", page: 12, bbox: { x: 22, y: 724, w: 540, h: 14 } },
      { text: "3. Doe, A. et al. Deep-learning maps for enhancer activity (2025).", page: 12, bbox: { x: 22, y: 706, w: 540, h: 14 } },
    ];

    const out = extractReferenceData(spans, "doc-ref7");
    expect(out.entries.some((entry) => entry.index === 1)).toBe(false);
    expect(out.entries.map((entry) => entry.index)).toEqual(expect.arrayContaining([2, 3]));
  });
});
