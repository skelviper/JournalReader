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

  it("matches lowercase fig/figure variants and supplementary prefixes", () => {
    const spans = [
      { text: "fig. 2: lower-case figure caption.", page: 6, bbox: { x: 16, y: 140, w: 250, h: 14 } },
      { text: "supplementary fig. S8: extra experiment.", page: 7, bbox: { x: 18, y: 126, w: 280, h: 14 } },
      { text: "extended data figure 4: benchmark controls.", page: 8, bbox: { x: 20, y: 110, w: 300, h: 14 } },
    ];

    const out = extractCaptions(spans);
    expect(out.map((item) => `${item.kind}:${item.label}`)).toEqual(
      expect.arrayContaining(["figure:2", "supplementary:S8", "supplementary:4"]),
    );
  });

  it("accepts captions with leading line-number noise and panel-letter body", () => {
    const spans = [
      {
        text: "1603 Extended Data Fig. 14",
        page: 11,
        bbox: { x: 18, y: 140, w: 220, h: 14 },
      },
      {
        text: "a, Volcano plot showing perturbation effects.",
        page: 11,
        bbox: { x: 18, y: 126, w: 360, h: 14 },
      },
    ];

    const out = extractCaptions(spans);
    const cap = out.find((item) => item.kind === "supplementary" && item.label === "14");
    expect(cap).toBeTruthy();
    expect(cap?.caption).toContain("a, Volcano plot");
  });

  it("continues caption text onto next page when previous page ends near bottom", () => {
    const spans = [
      { text: "Fig. 5: Multi-page caption start.", page: 4, bbox: { x: 24, y: 52, w: 320, h: 14 } },
      { text: "a, Description at bottom of page.", page: 4, bbox: { x: 24, y: 34, w: 340, h: 14 } },
      { text: "b, Continuation appears at top of next page.", page: 5, bbox: { x: 24, y: 760, w: 360, h: 14 } },
      { text: "c, Another continuation line.", page: 5, bbox: { x: 24, y: 742, w: 260, h: 14 } },
    ];

    const out = extractCaptions(spans);
    const cap = out.find((item) => item.kind === "figure" && item.label === "5");
    expect(cap).toBeTruthy();
    expect(cap?.caption).toContain("a, Description at bottom of page.");
    expect(cap?.caption).toContain("b, Continuation appears at top of next page.");
    expect(cap?.caption).toContain("c, Another continuation line.");
  });

  it("does not cross pages for long same-page captions", () => {
    const spans = [
      { text: "Fig. 3: Long caption title with sufficient body on current page.", page: 12, bbox: { x: 22, y: 80, w: 420, h: 14 } },
      { text: "a, first continuation on same page.", page: 12, bbox: { x: 22, y: 62, w: 300, h: 14 } },
      { text: "b, second continuation on same page.", page: 12, bbox: { x: 22, y: 44, w: 320, h: 14 } },
      { text: "c, this is still same-page content.", page: 12, bbox: { x: 22, y: 26, w: 300, h: 14 } },
      { text: "The next page starts body text and should not be appended.", page: 13, bbox: { x: 22, y: 760, w: 480, h: 14 } },
    ];

    const out = extractCaptions(spans);
    const cap = out.find((item) => item.kind === "figure" && item.label === "3");
    expect(cap).toBeTruthy();
    expect(cap?.caption).toContain("c, this is still same-page content.");
    expect(cap?.caption).not.toContain("The next page starts body text");
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

  it("keeps collecting two-column caption continuation with wider line spacing", () => {
    const spans = [
      {
        text: "Fig. 1: Principle of PARM and validation.",
        page: 2,
        bbox: { x: 22, y: 168, w: 360, h: 12 },
      },
      { text: "a, Left col line 1.", page: 2, bbox: { x: 22, y: 140, w: 320, h: 12 } },
      { text: "g, Right col line 1.", page: 2, bbox: { x: 452, y: 140, w: 340, h: 12 } },
      { text: "b, Left col line 2.", page: 2, bbox: { x: 22, y: 112, w: 320, h: 12 } },
      { text: "h, Right col line 2.", page: 2, bbox: { x: 452, y: 112, w: 340, h: 12 } },
      { text: "c, Left col line 3.", page: 2, bbox: { x: 22, y: 84, w: 320, h: 12 } },
      { text: "i, Right col line 3.", page: 2, bbox: { x: 452, y: 84, w: 340, h: 12 } },
      { text: "d, Left col line 4.", page: 2, bbox: { x: 22, y: 56, w: 320, h: 12 } },
    ];

    const out = extractCaptions(spans);
    const fig1 = out.find((item) => item.kind === "figure" && item.label === "1");
    expect(fig1).toBeTruthy();
    const caption = fig1?.caption ?? "";
    expect(caption).toContain("d, Left col line 4.");
    expect(caption.indexOf("c, Left col line 3.")).toBeLessThan(caption.indexOf("d, Left col line 4."));
    expect(caption.indexOf("d, Left col line 4.")).toBeLessThan(caption.indexOf("g, Right col line 1."));
  });
});
