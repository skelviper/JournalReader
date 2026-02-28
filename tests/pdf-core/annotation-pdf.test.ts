import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "pdf-lib";
import type { AnnotationItem } from "@journal-reader/types";
import { loadAnnotationsFromPdf, saveAnnotationsToPdf } from "@journal-reader/pdf-core";

function makeNumberArray(pdf: PDFDocument, values: number[]): PDFArray {
  const out = PDFArray.withContext(pdf.context);
  for (const value of values) {
    out.push(PDFNumber.of(value));
  }
  return out;
}

function decodeText(value: PDFString | PDFHexString | undefined): string | undefined {
  return value?.decodeText();
}

describe("pdf annotation persistence", () => {
  let root = "";
  let pdfPath = "";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "jr-pdf-core-"));
    pdfPath = join(root, "paper.pdf");

    const pdf = await PDFDocument.create();
    pdf.addPage([600, 800]);
    const bytes = await pdf.save();
    writeFileSync(pdfPath, bytes);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips journal annotations via PDF objects", async () => {
    const input: AnnotationItem[] = [
      {
        id: "hl-1",
        docId: "doc",
        page: 1,
        kind: "highlight",
        rects: [
          { x: 100, y: 680, w: 84, h: 12 },
          { x: 188, y: 680, w: 46, h: 12 },
        ],
        text: "CAPTION_WORD_HL::target-1::Principle of PARM",
        color: "#fce588",
        createdAt: "2026-02-28T10:00:00.000Z",
        updatedAt: "2026-02-28T10:01:00.000Z",
      },
      {
        id: "sticky-1",
        docId: "doc",
        page: 1,
        kind: "sticky-note",
        rects: [{ x: 220, y: 540, w: 120, h: 80 }],
        text: "todo",
        color: "#ffe89e",
        createdAt: "2026-02-28T10:02:00.000Z",
        updatedAt: "2026-02-28T10:03:00.000Z",
      },
    ];

    await saveAnnotationsToPdf(pdfPath, input);
    const loaded = await loadAnnotationsFromPdf(pdfPath);

    expect(loaded).toHaveLength(2);
    const highlight = loaded.find((item) => item.id === "hl-1");
    const sticky = loaded.find((item) => item.id === "sticky-1");

    expect(highlight?.kind).toBe("highlight");
    expect(highlight?.text).toContain("CAPTION_WORD_HL::target-1::");
    expect(highlight?.rects).toHaveLength(2);
    expect(sticky?.kind).toBe("sticky-note");
    expect(sticky?.text).toBe("todo");
  });

  it("replaces prior journal annotations but preserves non-journal annotations", async () => {
    const pdf = await PDFDocument.load(readFileSync(pdfPath));
    const page = pdf.getPages()[0];
    if (!page) {
      throw new Error("missing page");
    }

    const external = PDFDict.withContext(pdf.context);
    external.set(PDFName.of("Type"), PDFName.of("Annot"));
    external.set(PDFName.of("Subtype"), PDFName.of("Text"));
    external.set(PDFName.of("NM"), PDFString.of("EXT:1"));
    external.set(PDFName.of("Rect"), makeNumberArray(pdf, [20, 20, 48, 48]));
    external.set(PDFName.of("Contents"), PDFString.of("external note"));
    const extRef = pdf.context.register(external);
    const annots = PDFArray.withContext(pdf.context);
    annots.push(extRef);
    page.node.set(PDFName.of("Annots"), annots);
    writeFileSync(pdfPath, await pdf.save());

    await saveAnnotationsToPdf(pdfPath, [
      {
        id: "first",
        docId: "doc",
        page: 1,
        kind: "highlight",
        rects: [{ x: 80, y: 700, w: 100, h: 10 }],
        color: "#fce588",
        createdAt: "2026-02-28T11:00:00.000Z",
        updatedAt: "2026-02-28T11:00:00.000Z",
      },
    ]);

    await saveAnnotationsToPdf(pdfPath, [
      {
        id: "second",
        docId: "doc",
        page: 1,
        kind: "text-note",
        rects: [{ x: 140, y: 620, w: 120, h: 20 }],
        text: "new note",
        color: "#fff7cb",
        createdAt: "2026-02-28T11:05:00.000Z",
        updatedAt: "2026-02-28T11:05:00.000Z",
      },
    ]);

    const loaded = await loadAnnotationsFromPdf(pdfPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("second");
    expect(loaded[0]?.kind).toBe("text-note");

    const after = await PDFDocument.load(readFileSync(pdfPath));
    const firstPage = after.getPages()[0];
    const finalAnnots = firstPage?.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    let hasExternal = false;
    if (finalAnnots) {
      for (let i = 0; i < finalAnnots.size(); i += 1) {
        const dict = finalAnnots.lookupMaybe(i, PDFDict);
        const nm = decodeText(dict?.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
        if (nm === "EXT:1") {
          hasExternal = true;
          break;
        }
      }
    }
    expect(hasExternal).toBe(true);
  });
});
