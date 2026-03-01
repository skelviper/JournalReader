import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ParsedTextSpan, Rect } from "@journal-reader/types";

const require = createRequire(import.meta.url);
const workerModulePath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
const cMapDir = join(pdfjsRoot, "cmaps");
const standardFontsDir = join(pdfjsRoot, "standard_fonts");
const cMapUrl = `${cMapDir.replace(/\/?$/, "/")}`;
const standardFontDataUrl = `${standardFontsDir.replace(/\/?$/, "/")}`;
GlobalWorkerOptions.workerSrc = pathToFileURL(workerModulePath).toString();

type OpenedPdf = {
  pageCount: number;
  title: string;
};

type GetDocumentInput = Parameters<typeof getDocument>[0];

function buildNodeDocumentInput(data: Uint8Array): GetDocumentInput {
  const input: GetDocumentInput & { disableWorker: boolean } = {
    data,
    // Node-side parsing in main process should not spawn a PDF.js worker.
    disableWorker: true,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
  };
  return input;
}

function normalizeRect(a: [number, number], b: [number, number]): Rect {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return {
    x: x0,
    y: y0,
    w: Math.max(1, x1 - x0),
    h: Math.max(1, y1 - y0),
  };
}

export async function openPdfMetadata(path: string): Promise<OpenedPdf> {
  const buf = await readFile(path);
  const loadingTask = getDocument(buildNodeDocumentInput(new Uint8Array(buf)));
  const doc = await loadingTask.promise;

  try {
    const metadata = await doc.getMetadata().catch(() => null);
    const info = metadata?.info as Record<string, unknown> | undefined;
    const infoTitle = typeof info?.Title === "string" ? info.Title : undefined;
    const title =
      infoTitle ||
      metadata?.metadata?.get?.("dc:title") ||
      path.split("/").pop() ||
      "Untitled PDF";

    return {
      pageCount: doc.numPages,
      title,
    };
  } finally {
    await doc.destroy();
  }
}

export async function extractTextSpans(path: string): Promise<ParsedTextSpan[]> {
  const buf = await readFile(path);
  const loadingTask = getDocument(buildNodeDocumentInput(new Uint8Array(buf)));
  const doc = await loadingTask.promise;
  const spans: ParsedTextSpan[] = [];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      for (const item of content.items) {
        if (!("str" in item && "transform" in item)) {
          continue;
        }
        const text = item.str.trim();
        if (!text) {
          continue;
        }

        const tx = Util.transform(viewport.transform, item.transform);
        const width = Math.max(1, ("width" in item ? item.width : 10) || 10);
        const height = Math.max(1, ("height" in item ? item.height : 12) || 12);
        const topLeft = viewport.convertToPdfPoint(tx[4] ?? 0, (tx[5] ?? 0) - height) as [number, number];
        const bottomRight = viewport.convertToPdfPoint((tx[4] ?? 0) + width, tx[5] ?? 0) as [number, number];
        const rect = normalizeRect(topLeft, bottomRight);

        spans.push({
          text,
          page: pageNum,
          bbox: rect,
        });
      }
    }
  } finally {
    await doc.destroy();
  }

  return spans;
}
