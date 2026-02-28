import { describe, expect, it } from "vitest";
import { extractCaptions } from "@journal-reader/parser";

describe("extractCaptions", () => {
  it("detects figure/table/supplementary captions", () => {
    const spans = [
      {
        text: "Figure 2: Main architecture.",
        page: 5,
        bbox: { x: 10, y: 100, w: 220, h: 16 },
      },
      {
        text: "Table 1 Results on benchmark.",
        page: 5,
        bbox: { x: 10, y: 300, w: 220, h: 16 },
      },
      {
        text: "Supplementary Figure S3: More cases.",
        page: 8,
        bbox: { x: 10, y: 100, w: 220, h: 16 },
      },
      {
        text: "Fig. S4: Additional diagnostics.",
        page: 9,
        bbox: { x: 10, y: 120, w: 220, h: 16 },
      },
      {
        text: "Extended Data Fig. 5: Control experiments.",
        page: 10,
        bbox: { x: 10, y: 130, w: 260, h: 16 },
      },
      {
        text: "Fig. 1a,b). No previous knowledge other than the MPRA data was used",
        page: 2,
        bbox: { x: 10, y: 180, w: 340, h: 16 },
      },
    ];

    const out = extractCaptions(spans);
    expect(out).toHaveLength(5);
    expect(out.map((item) => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining(["figure:2", "table:1", "supplementary:S3", "supplementary:S4", "supplementary:5"]),
    );
    expect(out.some((item) => item.caption.includes("No previous knowledge"))).toBe(false);
  });

  it("keeps multi-line caption body including subfigure descriptions", () => {
    const spans = [
      {
        text: "Fig. 1: Principle of PARM and validation.",
        page: 2,
        bbox: { x: 12, y: 120, w: 280, h: 16 },
      },
      {
        text: "a, Workflow of MPRA; b, Predicted activity;",
        page: 2,
        bbox: { x: 12, y: 106, w: 320, h: 16 },
      },
      {
        text: "c, Correlation between predicted and measured values.",
        page: 2,
        bbox: { x: 12, y: 92, w: 350, h: 16 },
      },
    ];

    const out = extractCaptions(spans);
    const fig1 = out.find((item) => item.kind === "figure" && item.label === "1");
    expect(fig1).toBeTruthy();
    expect(fig1?.caption).toContain("a, Workflow of MPRA");
    expect(fig1?.caption).toContain("c, Correlation between predicted and measured values");
  });

  it("keeps two-column caption continuation in column order (left then right)", () => {
    const spans = [
      {
        text: "Fig. 7: Two-column caption example.",
        page: 3,
        bbox: { x: 20, y: 120, w: 280, h: 16 },
      },
      { text: "a, Left col line 1.", page: 3, bbox: { x: 20, y: 106, w: 220, h: 16 } },
      { text: "d, Right col line 1.", page: 3, bbox: { x: 330, y: 106, w: 230, h: 16 } },
      { text: "b, Left col line 2.", page: 3, bbox: { x: 20, y: 92, w: 220, h: 16 } },
      { text: "e, Right col line 2.", page: 3, bbox: { x: 330, y: 92, w: 230, h: 16 } },
      { text: "c, Left col line 3.", page: 3, bbox: { x: 20, y: 78, w: 220, h: 16 } },
      { text: "f, Right col line 3.", page: 3, bbox: { x: 330, y: 78, w: 230, h: 16 } },
    ];

    const out = extractCaptions(spans);
    const fig7 = out.find((item) => item.kind === "figure" && item.label === "7");
    expect(fig7).toBeTruthy();
    const caption = fig7?.caption ?? "";
    expect(caption.indexOf("a, Left col line 1.")).toBeLessThan(caption.indexOf("b, Left col line 2."));
    expect(caption.indexOf("b, Left col line 2.")).toBeLessThan(caption.indexOf("c, Left col line 3."));
    expect(caption.indexOf("c, Left col line 3.")).toBeLessThan(caption.indexOf("d, Right col line 1."));
    expect(caption.indexOf("d, Right col line 1.")).toBeLessThan(caption.indexOf("e, Right col line 2."));
    expect(caption.indexOf("e, Right col line 2.")).toBeLessThan(caption.indexOf("f, Right col line 3."));
  });

  it("splits two-column continuation even when each side is a very wide span", () => {
    const spans = [
      {
        text: "Fig. 1: Principle of PARM and validation.",
        page: 2,
        bbox: { x: 20, y: 130, w: 400, h: 16 },
      },
      {
        text: "c, PARM-predicted activity of the same fragments in b.",
        page: 2,
        bbox: { x: 20, y: 116, w: 420, h: 16 },
      },
      {
        text: "h, Experimental validation of the activity of 232 bp synthetic",
        page: 2,
        bbox: { x: 470, y: 116, w: 440, h: 16 },
      },
      {
        text: "d, Correlation between predicted and measured values.",
        page: 2,
        bbox: { x: 20, y: 102, w: 420, h: 16 },
      },
      {
        text: "promoters by MPRA in K562 cells.",
        page: 2,
        bbox: { x: 470, y: 102, w: 360, h: 16 },
      },
    ];

    const out = extractCaptions(spans);
    const fig1 = out.find((item) => item.kind === "figure" && item.label === "1");
    expect(fig1).toBeTruthy();
    const caption = fig1?.caption ?? "";
    expect(caption.indexOf("c, PARM-predicted activity of the same fragments in b.")).toBeLessThan(
      caption.indexOf("d, Correlation between predicted and measured values."),
    );
    expect(caption.indexOf("d, Correlation between predicted and measured values.")).toBeLessThan(
      caption.indexOf("h, Experimental validation of the activity of 232 bp synthetic"),
    );
  });
});
