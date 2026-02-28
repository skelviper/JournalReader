import { describe, expect, it } from "vitest";
import { extractCitations } from "@journal-reader/parser";

describe("extractCitations", () => {
  it("extracts figure/table/supplementary refs", () => {
    const spans = [
      {
        text: "As shown in Fig. 2 and Table 1, our method wins.",
        page: 3,
        bbox: { x: 10, y: 20, w: 200, h: 18 },
      },
      {
        text: "See Supplementary Fig. S3 for ablation.",
        page: 4,
        bbox: { x: 10, y: 44, w: 220, h: 18 },
      },
      {
        text: "Detailed curves are in Fig. S4.",
        page: 5,
        bbox: { x: 10, y: 60, w: 180, h: 18 },
      },
      {
        text: "Extended Data Fig. 5 shows additional controls.",
        page: 6,
        bbox: { x: 10, y: 78, w: 250, h: 18 },
      },
    ];

    const out = extractCitations(spans, "docA");
    expect(out).toHaveLength(5);
    expect(out.map((item) => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining(["figure:2", "table:1", "supplementary:S3", "supplementary:S4", "supplementary:5"]),
    );
  });

  it("extracts citation when token is split across spans", () => {
    const spans = [
      {
        text: "See",
        page: 2,
        bbox: { x: 10, y: 120, w: 24, h: 12 },
      },
      {
        text: "Fig.",
        page: 2,
        bbox: { x: 36, y: 120, w: 26, h: 12 },
      },
      {
        text: "1a",
        page: 2,
        bbox: { x: 64, y: 120, w: 16, h: 12 },
      },
      {
        text: "for details",
        page: 2,
        bbox: { x: 84, y: 120, w: 62, h: 12 },
      },
    ];

    const out = extractCitations(spans, "docB");
    expect(out.some((item) => item.kind === "figure" && item.label === "1A")).toBe(true);
  });

  it("splits grouped subfigure citations into separate labels", () => {
    const spans = [
      {
        text: "Signals are shown in Fig. 1a,b and Fig. 2c.",
        page: 7,
        bbox: { x: 10, y: 20, w: 260, h: 16 },
      },
    ];

    const out = extractCitations(spans, "docC");
    expect(out.map((item) => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining(["figure:1A", "figure:1B", "figure:2C"]),
    );
  });

  it("treats Extended Data refs as supplementary and keeps subfigure labels", () => {
    const spans = [
      {
        text: "See Extended Data Fig. 4a,b for controls.",
        page: 8,
        bbox: { x: 10, y: 20, w: 280, h: 16 },
      },
    ];

    const out = extractCitations(spans, "docD");
    expect(out.map((item) => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining(["supplementary:4A", "supplementary:4B"]),
    );
  });
});
